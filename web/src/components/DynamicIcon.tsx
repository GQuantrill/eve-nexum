import { createElement, type ReactNode } from 'react';
import { usePhosphorIcons } from '../utils/phosphorIcons';

type IconWeight = 'thin' | 'light' | 'regular' | 'bold' | 'fill' | 'duotone';

interface DynamicIconProps {
  name:       string;
  size?:      number;
  weight?:    IconWeight;
  color?:     string;
  className?: string;
  /** Shown while the icon set is still loading, or when `name` resolves to
   *  nothing. Without it the host control renders EMPTY -- which on a button
   *  means there is nothing to see or aim at. */
  fallback?:  ReactNode;
}

// Renders a Phosphor icon chosen by NAME (user flag / custom-label icons). Only
// ever mounted when there's actually an icon to show, so the Phosphor set is
// pulled in only when a map uses a custom icon. Until the set has loaded it
// renders `fallback` (null by default, so decorative uses just pop in), and
// re-renders itself when it does. Anything the user has to CLICK should pass a
// fallback, or the control is invisible until the chunk arrives. `resolve` is a stable LOOKUP into the loaded module (not a
// component factory), so createElement here is a plain element, not a new
// component definition.
export function DynamicIcon({ name, fallback = null, ...props }: DynamicIconProps) {
  const { ready, resolve } = usePhosphorIcons();
  if (!ready) return fallback;
  const icon = resolve(name);
  return icon ? createElement(icon, props) : fallback;
}
