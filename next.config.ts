import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  cacheComponents: true,
  partialPrefetching: true,
  // pino 走原生 require，避免被打包（Next 已内置豁免，显式声明以防变动）
  serverExternalPackages: ["pino"],
};

export default nextConfig;
