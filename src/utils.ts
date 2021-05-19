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

export function extendConsole(){
	let log = console.log;
	let fs = require('fs');
	console.log = function(){
		log.apply(null,Array.from(arguments));
		let s = new Date().toString().split("GMT")[0].trim() + ":";
		for(let i = 0;i <arguments.length;i++){
			s += JSON.stringify(arguments[i]) +",";
		}
		s = s.slice(0,s.length-1);
		s += "\n";
		fs.appendFileSync('log.txt',s);
	}
	console.error = console.log;
	console.warn = console.log;
}
