// renderer.js
function displayTicker(ticker) {
    document.getElementById('ticker-data').innerHTML = `
      <p><strong>Symbol:</strong> ${ticker.symbol}</p>
      <p><strong>Last Price:</strong> ${ticker.last}</p>
      <p><strong>Bid:</strong> ${ticker.bid}</p>
      <p><strong>Ask:</strong> ${ticker.ask}</p>
      <p><strong>High:</strong> ${ticker.high}</p>
      <p><strong>Low:</strong> ${ticker.low}</p>
      <p><strong>Volume:</strong> ${ticker.baseVolume}</p>
      <p><strong>Timestamp:</strong> ${new Date(ticker.timestamp).toLocaleString()}</p>
    `;
  }
  
  async function watchTicker() {
    const symbol = 'BTC/USDT'; // You can make this dynamic as needed
    await window.api.watchTicker(symbol, (ticker) => {
      if (ticker) {
        displayTicker(ticker);
      } else {
        document.getElementById('ticker-data').innerText = 'Failed to fetch ticker data.';
      }
    });
  }
  
  watchTicker();
  