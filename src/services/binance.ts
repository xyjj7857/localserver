import CryptoJS from 'crypto-js';
import axios from 'axios';

export class BinanceService {
  private apiKey: string;
  private secretKey: string;
  private baseUrl: string;
  private timeOffset: number = 0;
  private ipSelection: 'local' | 'proxy' = 'proxy';

  private isNode = typeof window === 'undefined';

  constructor(apiKey: string, secretKey: string, baseUrl: string) {
    this.apiKey = apiKey.trim();
    this.secretKey = secretKey.trim();
    this.baseUrl = baseUrl.trim();
    this.syncTime();
  }

  setIpSelection(selection: 'local' | 'proxy') {
    this.ipSelection = selection;
  }

  async syncTime() {
    try {
      const start = Date.now();
      const url = `${this.baseUrl}/fapi/v1/time`;
      let data;

      if (this.ipSelection === 'proxy' && !this.isNode) {
        const response = await axios.post('/api/proxy', { url, method: 'GET' });
        data = response.data;
      } else {
        const response = await axios.get(url);
        data = response.data;
      }

      const end = Date.now();
      const serverTime = data.serverTime;
      // Offset = ServerTime - (LocalTime + Latency/2)
      this.timeOffset = serverTime - (start + (end - start) / 2);
      console.log(`Binance Time Synced. Offset: ${this.timeOffset}ms`);
    } catch (e) {
      console.error('Failed to sync time with Binance', e);
    }
  }

  getTimeOffset() {
    return this.timeOffset;
  }

  private async request(method: string, path: string, params: any = {}, signed: boolean = false) {
    const timestamp = Math.floor(Date.now() + this.timeOffset);
    const requestParams = { ...params };

    if (signed) {
      requestParams.timestamp = timestamp;
      requestParams.recvWindow = 60000; // Maximum allowed recvWindow
    }

    let queryString = Object.entries(requestParams)
      .map(([key, val]) => `${key}=${val}`)
      .join('&');

    if (signed) {
      const signature = CryptoJS.HmacSHA256(queryString, this.secretKey).toString();
      queryString += `&signature=${signature}`;
    }

    const url = `${this.baseUrl}${path}${queryString ? '?' + queryString : ''}`;
    const headers = {
      'X-MBX-APIKEY': this.apiKey,
    };
    
    try {
      let data;

      if (this.ipSelection === 'proxy' && !this.isNode) {
        const response = await axios.post('/api/proxy', { url, method, headers });
        data = response.data;
      } else {
        const response = await axios({
          url,
          method,
          headers,
          timeout: 15000
        });
        data = response.data;
      }

      return data;
    } catch (e: any) {
      // Handle axios error response
      const errorData = e.response?.data;
      const status = e.response?.status;

      if (errorData) {
        // Handle recvWindow error by re-syncing and retrying once
        if (errorData.code === -1021 && !params._isRetry) {
          console.warn('Timestamp error detected, re-syncing time and retrying...');
          await this.syncTime();
          return this.request(method, path, { ...params, _isRetry: true }, signed);
        }

        if (errorData.code === -2015) {
          const serverIp = this.ipSelection === 'proxy' ? await this.getIp() : '本地 IP';
          throw new Error(`币安 API 权限/IP 错误: 请确保已在币安 API 设置中勾选 "允许合约" 权限。如果开启了 IP 限制，请将当前请求 IP (${serverIp}) 加入白名单。`);
        }

        throw new Error(errorData.msg || `Binance API Error (${status})`);
      }

      if (!params._isRetry) {
        console.warn('Network error detected, retrying once...');
        if (this.ipSelection === 'local') {
          console.warn('Switching to proxy for retry...');
          this.ipSelection = 'proxy';
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
        return this.request(method, path, { ...params, _isRetry: true }, signed);
      }
      
      console.error('Binance Request Failed:', e);
      throw e;
    }
  }

  async getExchangeInfo() {
    return this.request('GET', '/fapi/v1/exchangeInfo');
  }

  async getKLines(symbol: string, interval: string, limit: number = 500, startTime?: number, endTime?: number) {
    const params: any = { symbol, interval, limit };
    if (startTime) params.startTime = startTime;
    if (endTime) params.endTime = endTime;
    return this.request('GET', '/fapi/v1/klines', params);
  }

  async getAccountInfo() {
    return this.request('GET', '/fapi/v2/account', {}, true);
  }

  async getPositions() {
    return this.request('GET', '/fapi/v2/positionRisk', {}, true);
  }

  async getOpenOrders(symbol?: string) {
    return this.request('GET', '/fapi/v1/openOrders', symbol ? { symbol } : {}, true);
  }

  async getOpenAlgoOrders(symbol?: string) {
    return this.request('GET', '/fapi/v1/openAlgoOrders', symbol ? { symbol } : {}, true);
  }

  async cancelAlgoOrder(algoId: string) {
    return this.request('DELETE', '/fapi/v1/algoOrder', { algoId }, true);
  }

  async createOrder(params: {
    symbol: string;
    side: 'BUY' | 'SELL';
    type: 'LIMIT' | 'MARKET' | 'STOP_MARKET' | 'TAKE_PROFIT_MARKET';
    quantity?: string;
    price?: string;
    stopPrice?: string;
    timeInForce?: 'GTC' | 'IOC' | 'FOK';
    reduceOnly?: string;
    closePosition?: string;
    workingType?: 'MARK_PRICE' | 'CONTRACT_PRICE';
    priceProtect?: string;
    positionSide?: string;
  }) {
    return this.request('POST', '/fapi/v1/order', params, true);
  }

  async createAlgoOrder(params: {
    symbol: string;
    side: 'BUY' | 'SELL';
    algoType: 'VP' | 'TWAP' | 'CONDITIONAL';
    type: 'STOP_MARKET' | 'TAKE_PROFIT_MARKET';
    quantity?: string;
    stopPrice?: string;
    triggerPrice?: string;
    reduceOnly?: string;
    workingType?: 'MARK_PRICE' | 'CONTRACT_PRICE';
    [key: string]: any;
  }) {
    return this.request('POST', '/fapi/v1/algoOrder', params, true);
  }

  async cancelAllOrders(symbol: string) {
    return this.request('DELETE', '/fapi/v1/allOpenOrders', { symbol }, true);
  }

  async setLeverage(symbol: string, leverage: number) {
    return this.request('POST', '/fapi/v1/leverage', { symbol, leverage }, true);
  }

  async createListenKey() {
    return this.request('POST', '/fapi/v1/listenKey', {}, false);
  }

  async keepAliveListenKey() {
    return this.request('PUT', '/fapi/v1/listenKey', {}, false);
  }

  async getIp() {
    // Fetch from our own backend to get server IP (always useful for whitelisting)
    try {
      if (this.isNode) {
        // In Node, we can't call our own API via relative path, but we can call it via localhost
        const res = await axios.get('http://localhost:3000/api/ip');
        return res.data.ip || 'Unknown';
      }
      console.log('Fetching server IP from /api/ip...');
      const res = await axios.get('/api/ip');
      return res.data.ip || 'Unknown';
    } catch (e: any) {
      console.error('Error fetching server IP:', e.message);
      return 'Unknown';
    }
  }
}
