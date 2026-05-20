import { css } from 'lit';

export const styles = [
  css`
    :root {
      color: var(--root-color);
      --root-font: 'Noto Sans';
      background-color: var(--root-background-color);
      font-family: var(--root-font);
      --md-block-quote-border: solid var(--root-background-color) 1px;
      --md-code-block-border: solid var(--root-background-color) 1px;
    }

    body {
      margin: 0;
    }

    :root {
      color-scheme: light;
      --md-code-font-family: 'Fira Code VF', 'noto sans mono', monospace;
      --md-block-quote-bgcolor: #f2f2f2;
      --md-code-block-bgcolor: #f2f2f2;
      --md-code-span-bgcolor: #e2e2e2;
      --md-block-selection-bgcolor: #ccc;
      --md-accent-color: #67f;
      --md-active-block-color: #eaeaea;
      --pkm-dialog-bgcolor: #f2f2f2;
      --root-color: black;
      --root-background-color: white;
      --md-tag-bgcolor: var(--md-accent-color);
    }

    @media (prefers-color-scheme: dark) {
      :root {
        color-scheme: dark;
        --md-block-quote-bgcolor: #3e3e3e;
        --md-code-block-bgcolor: #3e3e3e;
        --md-code-span-bgcolor: #4e4e4e;
        --md-accent-color: #78f;
        --md-block-selection-bgcolor: #888;
        --md-active-block-color: #303030;
        --pkm-dialog-bgcolor: #191919;
        --root-color: white;
        --root-background-color: rgb(40, 40, 40);
      }
    }
  `.styleSheet!,
];
