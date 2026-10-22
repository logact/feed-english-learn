This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
# or
yarn dev
# or
pnpm dev
# or
bun dev
```

Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

## 环境变量

| 变量 | 说明 | 默认值 |
| --- | --- | --- |
| `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL` | LLM 服务配置;无 key 时使用内置 Mock | `gpt-4o-mini` |
| `DAILY_TOKEN_LIMIT` | 每用户每日 token 限额(prompt + completion 合计),`0` 表示不限 | `100000` |
| `SYSTEM_DAILY_TOKEN_LIMIT` | 系统每日 token 总限额(所有用户合计),`0` 表示不限 | 不限 |
| `ENGINE_DB_PATH` | SQLite 数据库路径 | `data/engine.db` |

超出限额后所有 LLM 调用被拦截:材料生成接口返回 429,后台画像更新静默跳过(次日 UTC 零点重置)。

You can start editing the page by modifying `app/page.tsx`. The page auto-updates as you edit the file.

This project uses [`next/font`](https://nextjs.org/docs/app/building-your-application/optimizing/fonts) to automatically optimize and load [Geist](https://vercel.com/font), a new font family for Vercel.

## Learn More

To learn more about Next.js, take a look at the following resources:

- [Next.js Documentation](https://nextjs.org/docs) - learn about Next.js features and API.
- [Learn Next.js](https://nextjs.org/learn) - an interactive Next.js tutorial.

You can check out [the Next.js GitHub repository](https://github.com/vercel/next.js) - your feedback and contributions are welcome!

## Deploy on Vercel

The easiest way to deploy your Next.js app is to use the [Vercel Platform](https://vercel.com/new?utm_medium=default-template&filter=next.js&utm_source=create-next-app&utm_campaign=create-next-app-readme) from the creators of Next.js.

Check out our [Next.js deployment documentation](https://nextjs.org/docs/app/building-your-application/deploying) for more details.
