require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const https = require('https');

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });

const CHAIN_IDS = {
  ethereum: '1',
  bsc:      '56',
  base:     '8453',
};

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

async function fetchJSON_safe(url) {
  try { return await fetchJSON(url); } catch(e) { return null; }
}

function fmt(n) {
  if (!n || isNaN(n)) return '$0';
  if (n >= 1e9) return `$${(n/1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n/1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n/1e3).toFixed(2)}K`;
  return `$${n.toFixed(2)}`;
}

function isEVM(addr) { return /^0x[0-9a-fA-F]{40}$/.test(addr); }
function isSolana(addr) { return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(addr); }

async function getEthPrice() {
  try {
    const data = await fetchJSON('https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd');
    if (data?.ethereum?.usd) {
      console.log('ETH price from CoinGecko:', data.ethereum.usd);
      return data.ethereum.usd;
    }
  } catch(e) {}
  try {
    const data = await fetchJSON('https://api.dexscreener.com/latest/dex/pairs/ethereum/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640');
    if (data?.pair?.priceUsd) {
      console.log('ETH price from DexScreener pair:', data.pair.priceUsd);
      return parseFloat(data.pair.priceUsd);
    }
  } catch(e) {}
  console.log('ETH price fallback: 3000');
  return 3000;
}

async function getDexData(address) {
  const data = await fetchJSON_safe(`https://api.dexscreener.com/latest/dex/tokens/${address}`);
  if (!data || !data.pairs || !data.pairs.length) return null;
  return data.pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0))[0];
}

async function getLaunchData(address, chainId, pairAddress, ethPrice) {
  const chainNum = CHAIN_IDS[chainId];
  if (!chainNum || !pairAddress) {
    console.log('getLaunchData: missing chainNum or pairAddress', chainNum, pairAddress);
    return null;
  }

  try {
    const syncRes = await fetchJSON(
      `https://api.etherscan.io/v2/api?chainid=${chainNum}` +
      `&module=logs&action=getLogs` +
      `&address=${pairAddress}` +
      `&topic0=0x1c411e9a96e071241c2f21f7726b17ae89e3cab4c78be50e062b03a9fffbbad1` +
      `&fromBlock=0&toBlock=999999999&page=1&offset=50` +
      `&apikey=${process.env.ETHERSCAN_API_KEY}`
    );

    console.log('Sync events found:', syncRes?.result?.length);
    if (!syncRes?.result?.length) return null;

    const firstSync   = syncRes.result[0];
    const launchBlock = parseInt(firstSync.blockNumber, 16);
    console.log('Launch block:', launchBlock);

    const launchSyncs = syncRes.result.filter(s => parseInt(s.blockNumber, 16) === launchBlock);
    const lastSync    = launchSyncs[launchSyncs.length - 1];

    function parseReserves(syncEvent) {
      const d = syncEvent.data.slice(2);
      return {
        r0: BigInt('0x' + d.slice(0, 64)),
        r1: BigInt('0x' + d.slice(64, 128)),
      };
    }

    const initialReserves = parseReserves(firstSync);
    const postReserves    = parseReserves(lastSync);

    const txRes = await fetchJSON(
      `https://api.etherscan.io/v2/api?chainid=${chainNum}` +
      `&module=account&action=tokentx&contractaddress=${address}` +
      `&startblock=0&endblock=999999999&sort=asc&page=1&offset=200` +
      `&apikey=${process.env.ETHERSCAN_API_KEY}`
    );
    if (!Array.isArray(txRes?.result) || !txRes.result.length) {
      console.log('No token txs found');
      return null;
    }

    const decimals = parseInt(txRes.result[0].tokenDecimal) || 18;

    const supplyRes = await fetchJSON(
      `https://api.etherscan.io/v2/api?chainid=${chainNum}` +
      `&module=stats&action=tokensupply&contractaddress=${address}` +
      `&apikey=${process.env.ETHERSCAN_API_KEY}`
    );
    const totalSupply = parseFloat(supplyRes.result) / Math.pow(10, decimals);
    console.log('Total supply:', totalSupply, '| ETH price:', ethPrice);

    const r0_tok    = Number(initialReserves.r0) / Math.pow(10, decimals);
    const r1_tok    = Number(initialReserves.r1) / Math.pow(10, decimals);
    const tokenIsR0 = Math.abs(r0_tok - totalSupply) < Math.abs(r1_tok - totalSupply);

    const initEthReserve   = tokenIsR0 ? Number(initialReserves.r1) / 1e18 : Number(initialReserves.r0) / 1e18;
    const initTokenReserve = tokenIsR0 ? r0_tok : r1_tok;
    const postEthReserve   = tokenIsR0 ? Number(postReserves.r1) / 1e18 : Number(postReserves.r0) / 1e18;
    const postTokenReserve = tokenIsR0
      ? Number(postReserves.r0) / Math.pow(10, decimals)
      : Number(postReserves.r1) / Math.pow(10, decimals);

    console.log('Init ETH reserve:', initEthReserve, '| Init token reserve:', initTokenReserve);
    console.log('Post ETH reserve:', postEthReserve, '| Post token reserve:', postTokenReserve);

    const launchLiqUSD    = initEthReserve * ethPrice;
    const launchPrice     = initTokenReserve > 0 ? launchLiqUSD / initTokenReserve : 0;
    const launchMC        = launchPrice * totalSupply;

    const postLiqUSD      = postEthReserve * ethPrice;
    const postBundlePrice = postTokenReserve > 0 ? postLiqUSD / postTokenReserve : 0;
    const postBundleMC    = postBundlePrice * totalSupply;

    const ethSpent = Math.max(0, postEthReserve - initEthReserve);

    console.log('Launch MC:', launchMC, '| Post bundle MC:', postBundleMC);

    const DEAD = [
      '0x0000000000000000000000000000000000000000',
      '0x000000000000000000000000000000000000dead'
    ];

    const launchTxs = txRes.result.filter(tx =>
      parseInt(tx.blockNumber) === launchBlock &&
      tx.from.toLowerCase() === pairAddress.toLowerCase()
    );

    const wallets = {};
    launchTxs.forEach(tx => {
      if (DEAD.includes(tx.to.toLowerCase())) return;
      wallets[tx.to] = (wallets[tx.to] || 0) + parseFloat(tx.value) / Math.pow(10, decimals);
    });

    const bundledTotal = Object.values(wallets).reduce((a, b) => a + b, 0);
    const bundledPct   = totalSupply > 0 ? (bundledTotal / totalSupply) * 100 : 0;
    const walletCount  = Object.keys(wallets).length;
    const avgWalletPct = walletCount > 0 ? bundledPct / walletCount : 0;

    console.log('Bundle pct:', bundledPct, '| Wallets:', walletCount);

    return {
      launchBlock,
      launchMC,
      launchLiqUSD,
      initEthReserve,
      postBundleMC,
      postBundlePrice,
      postLiqUSD,
      ethSpent,
      bundledPct,
      walletCount,
      avgWalletPct,
      txCount: launchTxs.length,
    };

  } catch(e) {
    console.error('getLaunchData error:', e.message);
    return null;
  }
}

async function analyze(address, chatId) {
  const loadingMsg = await bot.sendMessage(chatId, '🔍 Analyzing token...');

  try {
    const [dex, ethPrice] = await Promise.all([getDexData(address), getEthPrice()]);
    console.log('ETH price fetched:', ethPrice);

    if (!dex) {
      return bot.editMessageText('❌ Token not found. Check the address and try again.', {
        chat_id: chatId, message_id: loadingMsg.message_id
      });
    }

    console.log('Chain:', dex.chainId, '| Pair:', dex.pairAddress);

    const chainId  = dex.chainId;
    const pairAddr = dex.pairAddress;
    const launch   = await getLaunchData(address, chainId, pairAddr, ethPrice);

    const name   = dex.baseToken?.name   || 'Unknown';
    const symbol = dex.baseToken?.symbol || '?';
    const price  = parseFloat(dex.priceUsd) || 0;
    const mc     = dex.fdv || dex.marketCap || 0;
    const liqUsd = dex.liquidity?.usd || 0;
    const vol24h = dex.volume?.h24 || 0;
    const change = dex.priceChange?.h24 || 0;

    const chainEmoji  = { ethereum: '🔷', bsc: '🟡', base: '🔵', solana: '🟣' }[chainId] || '⚪';
    const changeEmoji = change >= 0 ? '📈' : '📉';

    let reply = `${chainEmoji} *${name}* ($${symbol})\n`;
    reply += `\`${address}\`\n\n`;
    reply += `💰 *Current MC:* ${fmt(mc)}\n`;
    reply += `💧 *Liquidity:* ${fmt(liqUsd)}\n`;
    reply += `🪙 *Price:* $${price.toFixed(10)}\n`;
    reply += `${changeEmoji} *24h:* ${change >= 0 ? '+' : ''}${change.toFixed(2)}%\n`;
    reply += `📊 *Volume 24h:* ${fmt(vol24h)}\n`;

    if (launch) {
      reply += `\n━━━━━━━━━━━━━━\n`;
      reply += `📦 *Bundle Analysis*\n`;
      reply += `🧊 Launch Block: \`${launch.launchBlock}\`\n\n`;

      if (launch.bundledPct === 0 || launch.txCount === 0) {
        reply += `✅ *This token was not bundled at launch*\n\n`;
        reply += `*At Launch:*\n`;
        reply += `💰 MC: ${fmt(launch.launchMC)}\n`;
        reply += `💧 Liquidity: ${fmt(launch.launchLiqUSD)} (${launch.initEthReserve.toFixed(3)} ETH)\n`;
      } else {
        reply += `*At Launch (before bundle):*\n`;
        reply += `💰 MC: ${fmt(launch.launchMC)}\n`;
        reply += `💧 Liquidity: ${fmt(launch.launchLiqUSD)} (${launch.initEthReserve.toFixed(3)} ETH)\n\n`;

        reply += `*After Bundle:*\n`;
        reply += `💰 MC: ${fmt(launch.postBundleMC)}\n`;
        reply += `🪙 Price: $${launch.postBundlePrice.toFixed(10)}\n`;
        reply += `💧 Liquidity: ${fmt(launch.postLiqUSD)}\n`;
        reply += `💸 ETH Spent: ${launch.ethSpent.toFixed(3)} ETH\n\n`;

        reply += `📦 *Supply Bundled:* ${launch.bundledPct.toFixed(2)}%\n`;
        reply += `🔄 Launch Buys: ${launch.txCount}\n`;
        reply += `👥 Wallets: ${launch.walletCount} | Avg: ${launch.avgWalletPct.toFixed(2)}%\n`;

        if (launch.bundledPct > 30)      reply += `\n🚨 *HEAVY BUNDLE — Extreme rug risk*`;
        else if (launch.bundledPct > 15) reply += `\n⚠️ *HIGH BUNDLE — Proceed with caution*`;
        else if (launch.bundledPct > 5)  reply += `\n⚠️ Moderate bundle detected`;
        else                              reply += `\n✅ Low bundle`;
      }

    } else if (chainId === 'solana') {
      reply += `\n_Bundle data not available for Solana yet_`;
    } else {
      reply += `\n✅ *This token was not bundled*\n`;
      reply += `_Launch data unavailable — token may predate Uniswap V2, use a V3 pool, or launched on a CEX_`;
    }

    const dexUrl = dex.url || `https://dexscreener.com/${chainId}/${address}`;
    reply += `\n\n[📊 DexScreener](${dexUrl})`;

    bot.editMessageText(reply, {
      chat_id: chatId,
      message_id: loadingMsg.message_id,
      parse_mode: 'Markdown',
      disable_web_page_preview: true
    });

  } catch(e) {
    console.error(e);
    bot.editMessageText('❌ Something went wrong. Try again.', {
      chat_id: chatId, message_id: loadingMsg.message_id
    });
  }
}

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id,
    `👾 *Bundle Launch Analyzer*\n\nPaste any token contract address and I'll fetch everything automatically.\n\n✅ Ethereum  ✅ Base  ✅ BSC  ✅ Solana`,
    { parse_mode: 'Markdown' }
  );
});

bot.on('message', (msg) => {
  if (!msg.text) return;

  const text     = msg.text.trim();
  const chatType = msg.chat.type;
  const isGroup  = chatType === 'group' || chatType === 'supergroup';

  // In groups — ONLY respond to contract addresses, stay silent for everything else
  if (isGroup) {
    if (isEVM(text) || isSolana(text)) {
      analyze(text, msg.chat.id);
    }
    return;
  }

  // In private chat
  if (text.startsWith('/start')) {
    return bot.sendMessage(msg.chat.id,
      `👾 *Bundle Launch Analyzer*\n\nPaste any token contract address and I'll fetch everything automatically.\n\n✅ Ethereum  ✅ Base  ✅ BSC  ✅ Solana`,
      { parse_mode: 'Markdown' }
    );
  }

  if (isEVM(text) || isSolana(text)) {
    analyze(text, msg.chat.id);
  } else {
    bot.sendMessage(msg.chat.id, '⚠️ Send a valid contract address to analyze.');
  }
});

console.log('🤖 Bundle analyzer running...');