import { defineConfig } from "astro/config";
import sitemap from "@astrojs/sitemap";
import starlight from "@astrojs/starlight";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { unified } from "@astrojs/markdown-remark";

export default defineConfig({
  site: "https://madderscientist.github.io",
  base: process.env.BASE_PATH ?? "/",
  markdown: {
    processor: unified({ remarkPlugins: [remarkMath], rehypePlugins: [rehypeKatex] }),
  },
  integrations: [
    sitemap(),
    starlight({
      title: "jpFun",
      defaultLocale: "root",
      locales: {
        root: {
          label: "简体中文",
          lang: "zh-CN",
        },
      },
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/madderscientist/jpFun",
        },
      ],
      sidebar: [
        { label: "文档导航", slug: "docs" },
        {
          label: "Tutorial · 教程",
          items: [{ autogenerate: { directory: "docs/tutorial" } }],
        },
        {
          label: "函数速查",
          items: [{ autogenerate: { directory: "docs/reference" } }],
        },
        {
          label: "开发者文档",
          collapsed: true,
          items: [{ autogenerate: { directory: "docs/developer" } }],
        },
      ],
      customCss: ["./src/styles/custom.css"],
      components: {
        Header: "./src/components/Header.astro",
        MarkdownContent: "./src/components/MarkdownContent.astro",
      },
    }),
  ],
});