module.exports = {
  apps: [
    {
      name: "comprehensible-english",
      script: "server.js",
      node_args:
        "--env-file-if-exists=/var/lib/comprehensible-english/comprehensible-english.env",
      env: {
        NODE_ENV: "production",
        PORT: 3003,
        HOSTNAME: "0.0.0.0",
        ENGINE_DB_PATH: "/var/lib/comprehensible-english/engine.db",
        LOG_FILE: "/var/lib/comprehensible-english/logs/app.log",
        LLM_LOG_FILE: "/var/lib/comprehensible-english/logs/llm-calls.jsonl",
      },
      max_restarts: 10,
      restart_delay: 2000,
    },
  ],
};
