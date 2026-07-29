import { createElement } from 'react';
import { usePhosphorIcons } from '../utils/phosphorIcons';

type IconWeight = 'thin' | 'light' | 'regular' | 'bold' | 'fill' | 'duotone';

interface DynamicIconProps {
  name:       string;
  size?:      number;
  weight?:    IconWeight;
  color?:     string;
  className?: string;
}

// Renders a Phosphor icon chosen by NAME (user flag / custom-label icons). Only
// ever mounted when there's actually an icon to show, so the Phosphor set is
// pulled in only when a map uses a custom icon. Renders nothing until the set has
// loaded (the icons are decorative, so a brief pop-in is fine) and re-renders
// itself when it does. `resolve` is a stable LOOKUP into the loaded module (not a
// component factory), so createElement here is a plain element, not a new
// component definition.
export function DynamicIcon({ name, ...props }: DynamicIconProps) {
  const { ready, resolve } = usePhosphorIcons();
  if (!ready) return null;
  const icon = resolve(name);
  return icon ? createElement(icon, props) : null;
}
