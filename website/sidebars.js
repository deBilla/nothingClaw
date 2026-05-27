/** @type {import('@docusaurus/plugin-content-docs').SidebarsConfig} */
const sidebars = {
  docsSidebar: [
    {
      type: 'doc',
      id: 'README',
      label: 'Overview',
    },
    {
      type: 'category',
      label: 'Understand',
      collapsed: false,
      items: ['architecture', 'vs-nanoclaw'],
    },
    {
      type: 'category',
      label: 'Configure',
      collapsed: false,
      items: ['configuration', 'channels', 'providers', 'voice', 'google'],
    },
    {
      type: 'category',
      label: 'Operate',
      collapsed: false,
      items: ['operations', 'development'],
    },
  ],
};

module.exports = sidebars;
