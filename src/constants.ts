import { DEFAULT_SETTINGS as BASE_SETTINGS } from "./shared/constants";
import { AppSettings } from "./shared/types";

export const DEFAULT_SETTINGS: AppSettings = {
  ...BASE_SETTINGS,
  binance: {
    ...BASE_SETTINGS.binance,
    apiKey: import.meta.env.VITE_BINANCE_API_KEY || BASE_SETTINGS.binance.apiKey,
    secretKey: import.meta.env.VITE_BINANCE_SECRET_KEY || BASE_SETTINGS.binance.secretKey,
    baseUrl: import.meta.env.VITE_BINANCE_BASE_URL || BASE_SETTINGS.binance.baseUrl,
    wsUrl: import.meta.env.VITE_BINANCE_WS_URL || BASE_SETTINGS.binance.wsUrl,
  },
};
