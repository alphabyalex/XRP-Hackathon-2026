/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@moonshift/shared"],
  reactStrictMode: true,
  devIndicators: false,
  async redirects() {
    return [{ source: "/marketplace", destination: "/market", permanent: true }];
  },
};

export default nextConfig;
