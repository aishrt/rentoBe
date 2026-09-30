import type { ReactNode } from 'react';
import { Column, Row, Section, Text } from 'react-email';
import { emailTheme } from '../theme.js';

const { colors } = emailTheme;

/** Label and value rows, e.g. a booking's car, dates and pick-up (plan §7). */
export function EmailDetails({ rows }: { rows: { label: string; value: ReactNode }[] }) {
  return (
    <Section
      style={{
        backgroundColor: colors.canvas,
        borderRadius: '12px',
        padding: '16px 20px',
        margin: '8px 0 20px',
      }}
    >
      {rows.map((row) => (
        <Row key={row.label} style={{ margin: '0 0 8px' }}>
          <Column style={{ width: '38%', verticalAlign: 'top' }}>
            <Text style={{ fontSize: '14px', lineHeight: '22px', color: colors.muted, margin: 0 }}>
              {row.label}
            </Text>
          </Column>
          <Column style={{ verticalAlign: 'top' }}>
            <Text
              style={{ fontSize: '14px', lineHeight: '22px', color: colors.ink, margin: 0, fontWeight: 500 }}
            >
              {row.value}
            </Text>
          </Column>
        </Row>
      ))}
    </Section>
  );
}

export interface EmailPriceLine {
  label: string;
  /** Already formatted, e.g. "$267.00" or "-$42.00". */
  amount: string;
}

/** A price breakdown with a bold total and the GST included on its own line (plan §8.1, item 18). */
export function EmailPriceTable({
  lines,
  total,
  gst,
  totalLabel = 'Total (NZD)',
}: {
  lines: EmailPriceLine[];
  total: string;
  gst?: string;
  totalLabel?: string;
}) {
  const cell = { fontSize: '14px', lineHeight: '22px', color: colors.ink, margin: 0 };
  return (
    <Section style={{ margin: '8px 0 20px' }}>
      {lines.map((line) => (
        <Row key={line.label} style={{ borderBottom: `1px solid ${colors.line}` }}>
          <Column style={{ padding: '8px 0' }}>
            <Text style={cell}>{line.label}</Text>
          </Column>
          <Column style={{ padding: '8px 0', textAlign: 'right' }}>
            <Text style={cell}>{line.amount}</Text>
          </Column>
        </Row>
      ))}
      <Row>
        <Column style={{ padding: '12px 0 4px' }}>
          <Text style={{ ...cell, fontWeight: 700, fontSize: '16px' }}>{totalLabel}</Text>
        </Column>
        <Column style={{ padding: '12px 0 4px', textAlign: 'right' }}>
          <Text style={{ ...cell, fontWeight: 700, fontSize: '16px' }}>{total}</Text>
        </Column>
      </Row>
      {gst && (
        <Row>
          <Column>
            <Text style={{ ...cell, color: colors.muted }}>Includes GST of</Text>
          </Column>
          <Column style={{ textAlign: 'right' }}>
            <Text style={{ ...cell, color: colors.muted }}>{gst}</Text>
          </Column>
        </Row>
      )}
    </Section>
  );
}

/** Small print under the main message. */
export function EmailNote({ children }: { children: ReactNode }) {
  return (
    <Text style={{ fontSize: '13px', lineHeight: '20px', color: colors.muted, margin: '0 0 12px' }}>
      {children}
    </Text>
  );
}
