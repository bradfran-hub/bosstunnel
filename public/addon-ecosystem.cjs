module.exports = { apps: [{ name: 'my-boss-addon', script: './addon-example.mjs', instances: 1, exec_mode: 'fork', kill_timeout: 25000, env: { NODE_ENV: 'production', PORT: '3000' } }] };
