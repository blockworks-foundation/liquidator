import axios from 'axios';

export function notify(content) {
  if (process.env.WEBHOOK_URL) {
    axios.post(process.env.WEBHOOK_URL, {content});
  }
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export const getUnixTs = () => {
  return new Date().getTime() / 1000;
}


