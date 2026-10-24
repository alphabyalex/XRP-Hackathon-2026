/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@moonshift/shared"],
  reactStrictMode: true,
  async redirects() {
    return [{ source: "/marketplace", destination: "/market", permanent: true }];
  },
};

export default nextConfig;
