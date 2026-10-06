import type { WumpyApi } from './index'

declare global {
  interface Window {
    wumpy: WumpyApi
  }
}

export {}
