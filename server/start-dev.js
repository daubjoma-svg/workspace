// 本地开发启动脚本：在进程内设置 SOP_MASTER_KEY（规避后台任务环境变量被沙箱剥离的问题）。
// 仅用于本地联调/浏览器验证；生产环境仍必须通过真实环境变量注入密钥。
process.env.SOP_MASTER_KEY = process.env.SOP_MASTER_KEY
  || '8mFMuTXjIpAFcxw6jnWAyzaunfsW94ye4L32z9NSPBw=';
require('./src/index.js');
