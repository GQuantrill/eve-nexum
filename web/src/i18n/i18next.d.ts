import 'i18next';
import type enCommon from './locales/en/common.json';

// Makes t() keys type-checked and autocompleted against the English resource —
// a typo or missing key becomes a compile error. English is the source of truth;
// other locales mirror its shape.
declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'common';
    resources: {
      common: typeof enCommon;
    };
  }
}
