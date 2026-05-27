// @ts-check
const { themes } = require('prism-react-renderer');

/** @type {import('@docusaurus/types').Config} */
const config = {
  title: 'marsClaw',
  tagline: 'A personal chat agent — Telegram, Slack, WhatsApp on top of Claude or Gemini',
  favicon: 'img/favicon.svg',

  url: 'https://deBilla.github.io',
  baseUrl: '/marsclaw/',

  organizationName: 'deBilla',
  projectName: 'marsclaw',
  trailingSlash: false,

  onBrokenLinks: 'warn',
  onBrokenMarkdownLinks: 'warn',

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  presets: [
    [
      'classic',
      /** @type {import('@docusaurus/preset-classic').Options} */
      ({
        docs: {
          // Single source of truth: the markdown in /docs at the repo root,
          // so files render correctly on GitHub and in this site.
          path: '../docs',
          routeBasePath: 'docs',
          sidebarPath: require.resolve('./sidebars.js'),
          editUrl: 'https://github.com/deBilla/marsclaw/edit/main/',
          include: ['**/*.md', '**/*.mdx'],
          // Skip the README — it's the directory index and Docusaurus uses
          // it automatically; we don't need a route for it as a separate doc.
        },
        blog: false,
        theme: {
          customCss: require.resolve('./src/css/custom.css'),
        },
      }),
    ],
  ],

  themeConfig:
    /** @type {import('@docusaurus/preset-classic').ThemeConfig} */
    ({
      image: 'img/marsclaw-social.png',
      colorMode: {
        defaultMode: 'dark',
        disableSwitch: false,
        respectPrefersColorScheme: true,
      },
      navbar: {
        title: 'marsClaw',
        logo: {
          alt: 'marsClaw logo',
          src: 'img/logo.svg',
        },
        items: [
          {
            type: 'docSidebar',
            sidebarId: 'docsSidebar',
            position: 'left',
            label: 'Docs',
          },
          {
            to: '/docs/architecture',
            label: 'Architecture',
            position: 'left',
          },
          {
            to: '/docs/configuration',
            label: 'Configuration',
            position: 'left',
          },
          {
            href: 'https://github.com/deBilla/marsclaw',
            label: 'GitHub',
            position: 'right',
          },
        ],
      },
      footer: {
        style: 'dark',
        links: [
          {
            title: 'Docs',
            items: [
              { label: 'Architecture', to: '/docs/architecture' },
              { label: 'Configuration', to: '/docs/configuration' },
              { label: 'Channels', to: '/docs/channels' },
              { label: 'Providers', to: '/docs/providers' },
            ],
          },
          {
            title: 'Run it',
            items: [
              { label: 'Voice', to: '/docs/voice' },
              { label: 'Google integration', to: '/docs/google' },
              { label: 'Operations', to: '/docs/operations' },
              { label: 'Development', to: '/docs/development' },
            ],
          },
          {
            title: 'More',
            items: [
              { label: 'GitHub', href: 'https://github.com/deBilla/marsclaw' },
              { label: 'vs NanoClaw', to: '/docs/vs-nanoclaw' },
              { label: 'License (MIT)', href: 'https://github.com/deBilla/marsclaw/blob/main/LICENSE' },
            ],
          },
        ],
        copyright: `Copyright © ${new Date().getFullYear()} deBilla. MIT License.`,
      },
      prism: {
        theme: themes.vsDark,
        darkTheme: themes.vsDark,
        additionalLanguages: ['bash', 'json', 'typescript', 'yaml', 'sql', 'ini'],
      },
      algolia: undefined,
    }),
};

module.exports = config;
