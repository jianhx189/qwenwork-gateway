module.exports = {
  apps: [{
    name: 'qwenwork-gateway',
    script: 'server.mjs',
    cwd: '/vol5/1000/qwenwork-gateway',
    interpreter: '/vol5/1000/nodejs/bin/node',
    node_args: '--enable-source-maps',
    env: {
      PORT: '4021',
      NODE_ENV: 'production',
      TZ: 'Asia/Shanghai',
      REFRESH_MS: '600000'
    },
    autorestart: true,
    max_restarts: 20,
    restart_delay: 3000,
    out_file: '/vol5/1000/qwenwork-gateway/data/out.log',
    error_file: '/vol5/1000/qwenwork-gateway/data/err.log',
    merge_logs: true,
    time: true
  }]
}
