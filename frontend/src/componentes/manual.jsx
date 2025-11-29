// frontend/src/componentes/manual.jsx
import React from 'react';
import ManualInner from './manual/index.jsx'; // <- IMPORTANTE: aponta direto pro index da pasta

// Wrapper só para manter compatibilidade com os imports antigos:
//   import Manual from "./manual";
export default function Manual(props) {
  return <ManualInner {...props} />;
}