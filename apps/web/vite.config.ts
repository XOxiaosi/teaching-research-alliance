import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
export default defineConfig({ plugins: [tailwindcss()], server: { proxy: { "/v1": process.env.DEMO_API_ORIGIN ?? "http://127.0.0.1:3100" } }, build: { outDir: "build" } });
