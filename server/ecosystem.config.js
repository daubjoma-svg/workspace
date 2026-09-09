// PM2 进程守护配置：ai-sop 常驻 + 崩溃自动拉起
module.exports = {
  apps: [
    {
      name: 'ai-sop',
      cwd: '/Users/admin/workspace/code/sop-system/server',
      script: 'src/index.js',
      env: {
        NODE_ENV: 'production',
        SOP_MASTER_KEY: process.env.SOP_MASTER_KEY || '',
      },
      max_memory_restart: '300M',   // 内存超 300M 自动重启
      autorestart: true,            // 崩溃自动拉起
      restart_delay: 2000,          // 2s 后重启
      max_restarts: 20,             // 10 分钟内最多 20 次
      out_file: '/tmp/ai-sop-out.log',
      error_file: '/tmp/ai-sop-err.log',
      merge_logs: true,
      time: true,
    },
  ],
};
