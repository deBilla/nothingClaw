import React from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import useBaseUrl from '@docusaurus/useBaseUrl';
import Layout from '@theme/Layout';
import Heading from '@theme/Heading';
import styles from './index.module.css';

const features = [
  {
    title: 'Two SDKs, one wire',
    emoji: '🛰️',
    description: (
      <>
        Pick Claude or Gemini. Switch any time with <code>bun run provider</code>.
        Automatic Claude→Gemini failover when Claude is over-quota. The hardest
        80% of building an agent — reasoning loop, tools, context — is delegated
        to the SDK so we own ~5k lines of glue.
      </>
    ),
  },
  {
    title: 'Multi-channel',
    emoji: '💬',
    description: (
      <>
        Telegram, Slack (Socket Mode), and WhatsApp (Baileys, QR auth) baked in.
        Enable any combination. Images go through vision; WhatsApp voice notes
        are transcribed locally and the agent can reply in synthesized speech.
      </>
    ),
  },
  {
    title: 'Personal, hardened',
    emoji: '🛡️',
    description: (
      <>
        Per-thread message serialization, sandboxed <code>allowed_paths</code>,
        a Bash denylist, inbound rate limits, daily USD budget cap, startup
        circuit-breaker, daily backups. Designed for one person; built like it
        runs unattended.
      </>
    ),
  },
];

function Feature({ emoji, title, description }) {
  return (
    <div className={clsx('col col--4')}>
      <div className={styles.featureCard}>
        <div className={styles.featureEmoji}>{emoji}</div>
        <Heading as="h3">{title}</Heading>
        <p>{description}</p>
      </div>
    </div>
  );
}

function HomepageHeader() {
  const { siteConfig } = useDocusaurusContext();
  const logoUrl = useBaseUrl('/img/logo.svg');
  return (
    <header className={clsx('hero hero--primary', styles.heroBanner)}>
      <div className="container">
        <img src={logoUrl} alt="marsClaw" className={styles.heroLogo} />
        <Heading as="h1" className={styles.heroTitle}>
          <span className={styles.brandOrange}>mars</span>
          <span className={styles.brandAsh}>Claw</span>
        </Heading>
        <p className={styles.heroTagline}>{siteConfig.tagline}</p>

        <div className={styles.installBlock}>
          <code className={styles.installCommand}>
            git clone https://github.com/deBilla/marsclaw &amp;&amp; cd marsclaw &amp;&amp; bash setup.sh
          </code>
        </div>

        <div className={styles.buttons}>
          <Link className="button button--primary button--lg" to="/docs/">
            Read the docs →
          </Link>
          <Link
            className="button button--secondary button--lg"
            href="https://github.com/deBilla/marsclaw"
            style={{ marginLeft: '1rem' }}
          >
            GitHub
          </Link>
        </div>
      </div>
    </header>
  );
}

function QuickStartSection() {
  return (
    <section className={styles.quickStart}>
      <div className="container">
        <Heading as="h2" className="text--center">From clone to a running bot in ~2 minutes</Heading>
        <div className={styles.codeGrid}>
          <div className={styles.codeStep}>
            <span className={styles.stepNum}>1</span>
            <Heading as="h4">Setup</Heading>
            <pre className={styles.codeBlock}>{`bash setup.sh`}</pre>
            <p>Interactive: pick provider, log in (auto-detected if you already are), wire up channels.</p>
          </div>
          <div className={styles.codeStep}>
            <span className={styles.stepNum}>2</span>
            <Heading as="h4">Link WhatsApp (optional)</Heading>
            <pre className={styles.codeBlock}>{`# scan the QR shown in
# the setup flow
# from your phone:
# Settings → Linked devices`}</pre>
            <p>Or set <code>TELEGRAM_BOT_TOKEN</code> / Slack tokens — any combination of channels.</p>
          </div>
          <div className={styles.codeStep}>
            <span className={styles.stepNum}>3</span>
            <Heading as="h4">Start</Heading>
            <pre className={styles.codeBlock}>{`bun run start`}</pre>
            <p>Or install as a launchd service: <code>bun run service install</code>. Message your bot.</p>
          </div>
        </div>
      </div>
    </section>
  );
}

function ArchitectureSection() {
  return (
    <section className={styles.arch}>
      <div className="container">
        <div className="row">
          <div className="col col--6">
            <Heading as="h2">Why it's small</Heading>
            <p>
              The whole codebase is ~5k lines of TypeScript. The hardest parts of
              building an agent — the reasoning loop, context compaction, the
              built-in tools (shell, read/write/edit, glob, grep, web fetch/search),
              model selection, retry logic — are delegated to the Claude Agent SDK
              or the Gemini CLI core.
            </p>
            <p>
              We own the chat-side glue: channel adapters, SQLite, an MCP server
              with channel-specific tools (<code>send_message</code>, <code>send_file</code>,{' '}
              <code>speak</code>, Gmail/Calendar/Drive/…), and ~5 files of
              context engineering.
            </p>
            <p>
              When Anthropic or Google ship a better model or improved tool use,
              we get it for free.
            </p>
            <Link className="button button--primary" to="/docs/architecture">
              Read the architecture →
            </Link>
          </div>
          <div className="col col--6">
            <pre className={styles.archDiagram}>{`┌──────────────────┐         ┌──────────────────────────┐
│ channel adapter  │ text ─▶ │  handleMessage           │
│ · telegram       │         │  · persist to sqlite     │
│ · slack          │         │  · build prompt          │
│ · whatsapp       │ audio?▶ │  · gemini / claude SDK   │
└──────────────────┘ whisper │  · send reply            │
        ▲           :9000    └──────────────────────────┘
        │                                │
        │                       speak()  │  ← MCP
        │                     kokoro     │
        │                     :9001      ▼
        └─ router.send ◀── outbox drain ─┘`}</pre>
          </div>
        </div>
      </div>
    </section>
  );
}

export default function Home() {
  const { siteConfig } = useDocusaurusContext();
  return (
    <Layout
      title={`${siteConfig.title} — a personal chat agent`}
      description="Telegram, Slack, and WhatsApp bot on top of Claude or Gemini. Voice in & out, Google integration, ~5k lines of TypeScript."
    >
      <HomepageHeader />
      <main>
        <section className={styles.features}>
          <div className="container">
            <div className="row">
              {features.map((props, idx) => (
                <Feature key={idx} {...props} />
              ))}
            </div>
          </div>
        </section>
        <QuickStartSection />
        <ArchitectureSection />
      </main>
    </Layout>
  );
}
