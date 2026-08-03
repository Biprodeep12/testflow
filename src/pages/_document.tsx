import { Html, Head, Main, NextScript } from "next/document";
import { THEME_BOOT_SCRIPT } from "@/lib/theme";

export default function Document() {
  return (
    <Html lang="en" suppressHydrationWarning>
      <Head>
        {/*
          Runs before the first paint, so the page is never drawn in the wrong
          theme and then corrected — that flash is the whole reason this is
          inline rather than an effect. It only reads localStorage and one media
          query, and sets a single class.
        */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </Head>
      <body className="antialiased">
        <Main />
        <NextScript />
      </body>
    </Html>
  );
}
