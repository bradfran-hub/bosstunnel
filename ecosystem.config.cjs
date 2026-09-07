module.exports = {
  apps: [
    {
      name: "bosstunnel",
      script: "./server.js",
      cwd: __dirname,
      exec_mode: "fork",
      instances: 1,
      kill_timeout: 25000,
      env: {
        NODE_ENV: "production",
        HOST: "0.0.0.0",
        PORT: "3000",
        BASE_PATH: process.env.BASE_PATH || "/",
        PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL || "https://bosstunnel.com"
      },
      max_memory_restart: "512M",
      time: true
    }
  ]
};
