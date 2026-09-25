import type { ReactNode } from 'react';
import { Body, Button, Container, Head, Heading, Hr, Html, Preview, Section, Text } from 'react-email';
import { emailTheme } from '../theme.js';

const { colors, fonts, radius } = emailTheme;

interface EmailLayoutProps {
  /** The short line email clients show next to the subject. */
  preview: string;
  children: ReactNode;
}

/** The shared frame for every Rento Vroom email: brand header, content card and footer. */
export function EmailLayout({ preview, children }: EmailLayoutProps) {
  return (
    <Html lang="en-NZ">
      <Head />
      <Preview>{preview}</Preview>
      <Body style={{ backgroundColor: colors.canvas, fontFamily: fonts.body, margin: 0, padding: '32px 0' }}>
        <Container style={{ maxWidth: '560px', margin: '0 auto', padding: '0 16px' }}>
          <Section style={{ padding: '8px 0 24px' }}>
            <Text
              style={{
                fontFamily: fonts.display,
                fontSize: '22px',
                fontWeight: 600,
                letterSpacing: '-0.02em',
                color: colors.primary,
                margin: 0,
              }}
            >
              Rento Vroom
            </Text>
          </Section>

          <Section
            style={{
              backgroundColor: colors.surface,
              border: `1px solid ${colors.line}`,
              borderRadius: radius.card,
              padding: '32px',
            }}
          >
            {children}
          </Section>

          <Section style={{ padding: '24px 8px 0' }}>
            <Hr style={{ borderColor: colors.line, margin: '0 0 16px' }} />
            <Text style={{ fontSize: '12px', lineHeight: '18px', color: colors.muted, margin: 0 }}>
              Rento Vroom · Car sharing with local owners across Aotearoa New Zealand.
            </Text>
            <Text style={{ fontSize: '12px', lineHeight: '18px', color: colors.muted, margin: '8px 0 0' }}>
              You're receiving this email because of activity on your Rento Vroom account.
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

export function EmailHeading({ children }: { children: ReactNode }) {
  return (
    <Heading
      as="h1"
      style={{
        fontFamily: fonts.display,
        fontSize: '28px',
        lineHeight: '34px',
        fontWeight: 500,
        letterSpacing: '-0.02em',
        color: colors.ink,
        margin: '0 0 16px',
      }}
    >
      {children}
    </Heading>
  );
}

export function EmailText({ children }: { children: ReactNode }) {
  return (
    <Text style={{ fontSize: '16px', lineHeight: '26px', color: colors.ink, margin: '0 0 16px' }}>
      {children}
    </Text>
  );
}

export function EmailButton({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Button
      href={href}
      style={{
        backgroundColor: colors.primary,
        color: colors.surface,
        borderRadius: radius.control,
        fontSize: '16px',
        fontWeight: 600,
        padding: '14px 24px',
        textDecoration: 'none',
        display: 'inline-block',
        margin: '8px 0 16px',
      }}
    >
      {children}
    </Button>
  );
}
