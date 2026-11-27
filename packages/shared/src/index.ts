export * from './modules';
export * from './resolver';
export * from './permissions';

export const BRAND = {
  name: 'Scenorya',
  subtitle: 'Gestion associative, culturelle et événementielle',
  slogan: 'De la gestion aux applaudissements.',
  signature: 'Une application de TiceConnect',
  edition: 'Community',
  colors: {
    navy: '#102540',
    blue: '#1765AD',
    white: '#FFFFFF',
    background: '#F6F8FC',
    text: '#172B43',
    coral: '#EF7658',
    turquoise: '#008A9A',
    darkBackground: '#101B2B',
    darkText: '#EFF5FF',
  },
} as const;
export * from './money';
