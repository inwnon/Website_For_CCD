// What the shared browser scripts put on window for the pages and for each other (type checking only: npm run typecheck)
interface Window {
  // auth.js
  api: (path: string, opts?: { method?: string, body?: any, headers?: Record<string, string> }) => Promise<any>;
  ME: Promise<any>;
  loginUrl: (next?: string) => string;
  devLogin: (as: string) => Promise<void>;
  PROFILE: any;
  SUBS: any;
  roleName: (u: any) => string;
  MODULE_PAGES: { id: string; href: string; label: string; soon?: boolean; icon: string }[];
  baseRole: (u: any) => string;
  mountRoleSwitch: (box: Element, u: any) => void;
  renderAccountButton: (...args: any[]) => any;
  // other shared scripts
  arrivalsRepaint: () => void;
  onArrivals?: (items: any[]) => void;
  DESK: any;
  EventForm: any;
  NAME_PREFIXES: string[];
  ORG: any;
  Sortable: (list: Element, opts: any) => any;
  StoryPick: (opts: any) => any;
  TextTools: any;
  ThaiDate: any;
  VideoLinks: (box: Element, opts?: any) => any;
  // older browsers
  webkitAudioContext?: typeof AudioContext;
  clipboardData?: DataTransfer;
}
declare var api: Window['api'];
declare var DESK: Window['DESK'];
declare var EventForm: Window['EventForm'];
declare var ORG: Window['ORG'];
