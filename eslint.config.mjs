import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // 워커는 상시 서버(별도 툴링)에서 돌아 Next 앱 lint 범위 밖으로 둔다.
    "worker/**",
    // CLI 검증 산출물.
    "scratch/**",
  ]),
]);

export default eslintConfig;
