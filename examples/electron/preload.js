// preload.js
const { contextBridge } = require('electron');
const ccxtpro = require('ccxt.pro'); // Use ccxt.pro instead of ccxt

contextBridge.exposeInMainWorld('api', {
  watchTicker: async (symbol, callback) => {
    const exchange = new ccxtpro.binance();
    try {
      while (true) {
        const ticker = await exchange.watchTicker(symbol);
        callback(ticker);
      }
    } catch (error) {
      console.error('Error watching ticker:', error);
    }
  },
});
