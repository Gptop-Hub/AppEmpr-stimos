import React from 'react';
import VoiceAssistantDock from '../assistant/VoiceAssistantDock.jsx';

const styles = {
  page: {
    padding: 16,
    color: 'var(--text-main)',
  },
  title: {
    margin: 0,
    fontSize: '1.9rem',
    fontWeight: 700,
    textAlign: 'center',
  },
  subtitle: {
    margin: '8px auto 18px',
    maxWidth: 680,
    textAlign: 'center',
    color: 'var(--text-muted)',
    lineHeight: 1.45,
  },
};

export default function AssistentePage() {
  return (
    <section style={styles.page}>
      <h2 style={styles.title}>Assistente</h2>
      <p style={styles.subtitle}>
        Pronta para ajudar! O que você precisa agora?
      </p>
      <VoiceAssistantDock floating={false} />
    </section>
  );
}
