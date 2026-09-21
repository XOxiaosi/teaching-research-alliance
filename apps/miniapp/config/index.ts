import { defineConfig } from '@tarojs/cli';

const development = process.env.TARO_APP_ENV === 'development';
const apiBase = process.env.TARO_APP_API_BASE_URL ?? (development ? 'http://127.0.0.1:3100' : '');
if (!apiBase) throw new Error('TARO_APP_API_BASE_URL_REQUIRED');
const endpoint = new URL(apiBase);
if (!development && endpoint.protocol !== 'https:') throw new Error('HTTPS_API_REQUIRED');
if (development && endpoint.protocol !== 'https:' && !['localhost','127.0.0.1','[::1]'].includes(endpoint.hostname)) throw new Error('LOCAL_DEVELOPMENT_API_REQUIRED');

export default defineConfig({
  projectName: 'teaching-research-alliance',
  date: '2026-09-21',
  designWidth: 750,
  deviceRatio: { 375: 2, 640: 2.34/2, 750: 1, 828: 1.81/2 },
  sourceRoot: 'src',
  outputRoot: 'build',
  framework: 'react',
  compiler: 'webpack5',
  cache: { enable: false },
  defineConstants: { __API_BASE_URL__: JSON.stringify(apiBase.replace(/\/$/, '')) },
  mini: {},
});
