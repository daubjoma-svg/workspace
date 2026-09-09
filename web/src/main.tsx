import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
// Token 单一真源，必须先于 styles.css 载入：
// 提供 :root（浅色）与 [data-mode="dark"]（深色）两套变量，styles.css 只做旧名别名映射。
import '../../design-system/design-tokens.css';
import './styles.css';

createRoot(document.getElementById('root')!).render(<App />);
