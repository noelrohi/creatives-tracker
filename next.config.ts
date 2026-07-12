import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactCompiler: true,
  experimental: {
    optimizePackageImports: ["recharts"],
  },
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
