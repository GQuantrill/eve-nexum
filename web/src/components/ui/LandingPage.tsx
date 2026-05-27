import { useEffect, useRef, useState } from 'react';
import type { Icon } from '@phosphor-icons/react';
import {
  GraphIcon, MapTrifoldIcon, GaugeIcon, MagnifyingGlassIcon, SelectionIcon, ImageIcon, HourglassIcon,
  UsersIcon, StackIcon, ArrowsMergeIcon, ArrowsClockwiseIcon, LockIcon, ShieldCheckIcon,
  CardsIcon, WaveformIcon, BuildingsIcon, SparkleIcon, ChartLineIcon, FlagBannerIcon, SwordIcon, HandshakeIcon,
  PathIcon, StarIcon, SnowflakeIcon, LightningIcon, WarningIcon, NavigationArrowIcon, MapPinIcon, BroadcastIcon, BellRingingIcon,
  CommandIcon, HouseIcon, SkullIcon, ChartBarIcon, PulseIcon, EyeIcon, SidebarIcon,
  SquaresFourIcon, UserGearIcon, TableIcon, ChartDonutIcon, ClockIcon, ClipboardTextIcon, TagIcon, IdentificationCardIcon,
} from '@phosphor-icons/react';
import { apiUrl } from '../../api/client';
import { DemoMap } from './DemoMap';
import portraitImg from '../../assets/portrait.jpeg';
interface LastCharacter { characterId: number; characterName: string; }

// Categorised feature sections that mirror the README's Key features tree.
// Cards still render through the same `landing__feature` template; each
// section gets a heading rendered above its grid.
interface FeatureItem { icon: Icon; title: string; desc: string }
interface FeatureSection { title: string; items: FeatureItem[] }

const FEATURE_SECTIONS: FeatureSection[] = [
  {
    title: 'Mapping',
    items: [
      {
        icon: GraphIcon,
        title: 'Interactive map',
        desc: 'Drag systems, draw connections, set wormhole class / type / status per connection. Snap-to-grid and an optional minimap.',
      },
      {
        icon: MapTrifoldIcon,
        title: 'Seed a map from a region',
        desc: 'Spin up a new map pre-populated with an entire EVE region — every system laid out from CCP\'s 2D star-map projection (a Dotlan-style layout) with all stargate connections drawn. Pick a region when creating a map, or leave it blank for an empty one.',
      },
      {
        icon: GaugeIcon,
        title: 'Wormhole intel',
        desc: 'Per-connection mass status (stable / destabilized / critical), end-of-life flag with countdown, K162-aware static identification, and frig-hole / gas-site auto-tagging from sig type.',
      },
      {
        icon: ArrowsClockwiseIcon,
        title: 'Rolling calculator',
        desc: 'Plan and track collapsing a hole from its connection panel. Models the ±10% mass variance and forecasts each pass safe / may-collapse / will-collapse against the worst case. Define a roller ship (cold + prop-on mass, or pull your flown ship from ESI), step through passes with side-tracking that warns before a pass strands you on the far side, and see an "≈ N passes left" estimate. Cumulative mass syncs live to everyone viewing the hole.',
      },
      {
        icon: MagnifyingGlassIcon,
        title: 'Wormhole type picker',
        desc: 'Searchable popover for assigning the exact wormhole type to a connection. Statics quick-info on hover shows destination class, mass, and lifetime.',
      },
      {
        icon: SelectionIcon,
        title: 'Multi-select bulk operations',
        desc: 'Shift-click to select multiple systems or signatures, then bulk-assign type, delete, or rename in a single action.',
      },
      {
        icon: ImageIcon,
        title: 'PNG export',
        desc: 'Render the current map — with sig counts, connections, and status — to a PNG you can drop into a fleet ping or a corp Discord.',
      },
      {
        icon: HourglassIcon,
        title: 'Wormhole sig aging',
        desc: 'Wormhole sigs tint by their position in the WH type\'s known lifetime — yellow at 50%, orange at 90%, red past expected close. Catches forgotten chains before they collapse on someone.',
      },
    ],
  },
  {
    title: 'Personal & corp maps',
    items: [
      {
        icon: UsersIcon,
        title: 'Solo / Corp split',
        desc: 'Every user has personal maps that are always private; in corp mode each corp also gets shared corp maps. Cross-corp visibility is opt-in via a single env flag.',
      },
      {
        icon: StackIcon,
        title: 'Multi-map support',
        desc: 'Each character (or corp) can maintain multiple independent maps up to configured limits — separate chains for separate ops without losing context.',
      },
      {
        icon: ArrowsMergeIcon,
        title: 'Merge maps',
        desc: 'Fold one map into another. The destination is kept as the source of truth — only missing systems and connections are added, with signatures, structures, and notes merged in, and new systems slotted into the existing layout. Corp maps opt in per role as a merge source and/or destination.',
      },
      {
        icon: BroadcastIcon,
        title: 'Real-time collaboration',
        desc: 'Edits sync live to everyone viewing the same map — systems, connections, rename/lock, signatures, structures, and merges all appear for other viewers within moments, no refresh. Streamed per map (you only get events for maps you can see), with your own changes echo-suppressed and an auto-resync on reconnect.',
      },
      {
        icon: LockIcon,
        title: 'Map locking',
        desc: 'Admins can freeze a corp map\'s topology. Systems and connections lock for non-admins, but signatures, structures, and per-system notes stay editable so ops continue while the layout is pinned.',
      },
      {
        icon: ShieldCheckIcon,
        title: 'Role-based access',
        desc: 'Four tiers — readonly, edit, full, admin — gating corp-map actions. Personal maps stay yours regardless of role.',
      },
    ],
  },
  {
    title: 'System intelligence',
    items: [
      {
        icon: CardsIcon,
        title: 'System panel',
        desc: 'Per-system cards for signatures, structures, NPC stations, notes, killboard, and activity charts. Cards are reorderable via drag-and-drop and persist per-user.',
      },
      {
        icon: WaveformIcon,
        title: 'Signature management',
        desc: 'Paste straight from the probe scanner. Tracks created / updated age per signature, auto-deletes sigs missing from a re-paste, and supports bulk type assignment for multi-select.',
      },
      {
        icon: BuildingsIcon,
        title: 'Structure import',
        desc: 'Paste EVE overview data to import player-owned structures with names, types, owners, and notes in one operation.',
      },
      {
        icon: SparkleIcon,
        title: 'Auto-discovered structures',
        desc: 'Your corp\'s citadels (via ESI when a member with the Station Manager role logs in) and any publicly-listed structures from a third-party feed appear automatically in the structures pane as read-only entries — already tinted by your standings toward the owner.',
      },
      {
        icon: ChartLineIcon,
        title: 'Activity charts',
        desc: '24-hour rolling history of jumps, ship / pod kills, and NPC kills per system, polled from ESI hourly. The poller persists data for every k-space system — not just ones someone has opened — so charts populate the moment you view a new system.',
      },
      {
        icon: FlagBannerIcon,
        title: 'Sovereignty & station data',
        desc: 'Live alliance / corp / faction sov info and NPC station services, with in-game waypoint and destination actions.',
      },
      {
        icon: SwordIcon,
        title: 'Killboard pane',
        desc: 'Recent zKillboard activity per system, with NPC-only kills hidden by default (toggle to include). Rows tint red when a hostile actor is in the chain or a blue gets killed; blue when a friendly scores or a hostile dies. Recent kills also bubble up as highlights on the map.',
      },
      {
        icon: SparkleIcon,
        title: 'Chain-wide effect digest',
        desc: 'A one-line summary at the top of the system info panel lists every Pulsar / Wolf-Rayet / Magnetar / etc. on the current chain. Hover for the modifier list; click to centre.',
      },
      {
        icon: HandshakeIcon,
        title: 'Standings overlay',
        desc: 'Your EVE contact list (personal, corp, and alliance — fetched via ESI on login and re-pullable on demand) drives a chain-wide visual layer. Sov holders show inline P/C/A standing pills; structures resolved via their EVE structure ID tint by owner-corp standing; sov-holder system nodes get a coloured halo so hostile territory stands out on the map.',
      },
    ],
  },
  {
    title: 'Live ops',
    items: [
      {
        icon: PathIcon,
        title: 'Scout connections',
        desc: 'Thera and Turnur public Eve-Scout connections surfaced into the sidebar so you can jump straight to known holes.',
      },
      {
        icon: StarIcon,
        title: 'A0 sun detection',
        desc: 'Auto-flags systems with A0 (yellow) suns visible via ESI for capital-friendly skirmish planning.',
      },
      {
        icon: SnowflakeIcon,
        title: 'Ice belt systems',
        desc: 'Flags Empire-space systems that spawn ice anomalies with a ❄ icon — handy when staging mining ops or looking for an alternate harvest spot. Static dataset committed in-repo and resolved to system IDs at startup.',
      },
      {
        icon: LightningIcon,
        title: 'Storm tracking',
        desc: 'Active null-sec storms — Electric, Gamma, Exotic, Plasma — sourced from the community-maintained EveScout Rescue stormtrack feed surface as a colour-coded ⚡ on matching system nodes. Tooltip shows storm name, last report, and reporter. Refreshed every 30 minutes.',
      },
      {
        icon: WarningIcon,
        title: 'Proximity alerts',
        desc: 'Browser notification plus an audio ping when you\'re within a configurable number of jumps of an active incursion, pirate insurgency, or a sov-holding system whose corp / alliance you\'ve set to red. Persistent toolbar chip shows the nearest threat at a glance.',
      },
      {
        icon: BellRingingIcon,
        title: 'Discord notifications',
        desc: 'Push corp chain intel to a Discord channel so alerts land even when nobody\'s watching the tab. Fires server-side on an inbound K162 or a new wormhole connection, scoped to corp maps. Admins filter which regions and maps notify from the admin panel. Best-effort and rate-limit-aware; bulk operations like region seeding never spam the channel.',
      },
      {
        icon: NavigationArrowIcon,
        title: 'Route planner',
        desc: 'Server-side BFS over stargates plus your live chain, so a route through a wormhole hop is a single click.',
      },
      {
        icon: MapPinIcon,
        title: 'Location tracking',
        desc: 'Opt-in live character location dot in the toolbar, plus a per-map "you are here" indicator that updates every 10 seconds via ESI.',
      },
      {
        icon: UsersIcon,
        title: 'Pilot presence',
        desc: 'See where everyone viewing the same map is right now — a blue dot (pilot name on hover) marks each other viewer\'s current system, live as they jump. Covers anyone with the map open, not just your fleet; opt-in and nothing is stored.',
      },
      {
        icon: BroadcastIcon,
        title: 'Online status',
        desc: 'Toolbar dot shows whether each logged-in user is currently signed into EVE Online, so you can see at a glance who\'s actually on grid.',
      },
    ],
  },
  {
    title: 'Productivity & UX',
    items: [
      {
        icon: CommandIcon,
        title: 'Command palette',
        desc: '⌘ / Ctrl + K opens a fuzzy search across systems, sigs, and actions — jump to a system, set a waypoint, or toggle a pane without touching the mouse.',
      },
      {
        icon: HouseIcon,
        title: 'Home hotkey',
        desc: 'Hit H to jump the viewport back to your home system from any panel. Right-click a system to set or change which one is home.',
      },
      {
        icon: SkullIcon,
        title: 'Recent-kill highlights',
        desc: 'Systems with kills in the last hour get a coloured halo so you can see fresh activity at a glance across the chain.',
      },
      {
        icon: ChartBarIcon,
        title: 'User stats modal',
        desc: 'Per-character totals: jumps, signatures by type, broken down by day / week / month / year / forever.',
      },
      {
        icon: PulseIcon,
        title: 'Server status widget',
        desc: 'Live Tranquility server status, player count, and ESI health in the toolbar. Cross-tab cached so all your open windows share a single ESI poll.',
      },
      {
        icon: EyeIcon,
        title: 'Demo map',
        desc: 'The landing page mounts a non-editable demo map so visitors can see what the tool does before logging in.',
      },
      {
        icon: SidebarIcon,
        title: 'Collapsible sidebar',
        desc: 'Map Options, Connections, Proximity Alerts, Stale System Fade, and Shortcuts each expand or collapse independently. Per-section state persists per browser via localStorage.',
      },
    ],
  },
];

// "For corporations" section in the README mirrored here. Hidden behind
// CORP_ID at the deployment level; admin-only at the UI level.
const CORP_FEATURES: FeatureItem[] = [
  {
    icon: BuildingsIcon,
    title: 'Multi-corp deployments',
    desc: 'CORP_ID accepts a comma-separated list of corporation IDs. One Nexum instance can host several corps; each corp\'s maps stay scoped to its own members unless CORP_MAP_SHARED=true.',
  },
  {
    icon: SquaresFourIcon,
    title: 'Admin dashboard',
    desc: 'A dedicated /admin page with four tabs: Users, Maps, Reports, and Audit log. Admins reach it from the toolbar\'s Admin button.',
  },
  {
    icon: UserGearIcon,
    title: 'User management',
    desc: 'Change roles, block / unblock, and force an ESI corp-membership re-check on demand. Self-block, self-demote, and changes to ADMIN_CHAR_ID are guarded against.',
  },
  {
    icon: MapTrifoldIcon,
    title: 'Map management',
    desc: 'Admins see every corp map with owner avatar, corp ticker, system / connection counts, lock state, and last-active time. Force-lock, force-unlock, and force-delete are one-click each.',
  },
  {
    icon: TableIcon,
    title: 'Users report',
    desc: 'Per-character last login, systems added / deleted, structures added, signatures broken down by type, and last-corp-activity timestamps. Sortable, filterable by activity and time window, exportable as CSV.',
  },
  {
    icon: ChartDonutIcon,
    title: 'Systems report',
    desc: 'Aggregate corp-map signatures with a sig-type donut, a daily / monthly activity line chart (bucketing adapts to the window), and a sortable wormhole-type breakdown.',
  },
  {
    icon: ClockIcon,
    title: 'Time-windowed reporting',
    desc: 'Every report can be scoped to past 24 hours, week, month, year, or all time. Chart bucketing adapts automatically: hourly for 24h, daily for week / month, monthly for year and all-time.',
  },
  {
    icon: ClipboardTextIcon,
    title: 'Audit log',
    desc: 'Every admin action — role change, block / unblock, force-lock, force-delete, ESI corp change, auto-block on corp departure — is recorded with actor, target, old → new value, and timestamp. Exportable as CSV.',
  },
  {
    icon: TagIcon,
    title: 'Corp ticker resolution',
    desc: 'Corp IDs in the Users and Maps reports are resolved to in-game tickers via ESI, with a 1-hour in-memory cache to keep report loads cheap.',
  },
  {
    icon: IdentificationCardIcon,
    title: 'Per-character attribution',
    desc: 'Sigs, structures, and system add / delete actions are recorded with the user who made them, so reports can answer "who has been scanning what" with no manual logging.',
  },
];

const VERT_SRC = `#version 300 es
in vec4 position;
void main(){gl_Position=position;}
`;

const FRAG_SRC = `#version 300 es
precision highp float;
out vec4 O;
uniform float time;
uniform vec2 resolution;
#define FC gl_FragCoord.xy
#define R resolution
#define T time
#define hue(a) (.6+.6*cos(6.3*(a)+vec3(0,83,21)))
float rnd(float a){
  vec2 p=fract(a*vec2(12.9898,78.233));
  p+=dot(p,p*345.);
  return fract(p.x*p.y);
}
vec3 pattern(vec2 uv){
  vec3 col=vec3(0);
  for(float i=.0;i++<20.;){
    float a=rnd(i);
    vec2 n=vec2(a,fract(a*34.56)),p=sin(n*(T+7.)+T*.5);
    float d=dot(uv-p,uv-p);
    col+=.00125/d*hue(dot(uv,uv)+i*.125+T);
  }
  return col;
}
void main(void){
  vec2 uv=(FC-.5*R)/min(R.x,R.y);
  vec3 col=vec3(0);
  float s=2.4,a=atan(uv.x,uv.y),b=length(uv);
  uv=vec2(a*5./6.28318,.05/tan(b)+T);
  uv=fract(uv)-.5;
  col+=pattern(uv*s);
  O=vec4(col,1);
}
`;

function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, src);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

function useShaderCanvas(canvasRef: React.RefObject<HTMLCanvasElement | null>) {
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const gl = canvas.getContext('webgl2');
    if (!gl) return;

    const vert = compileShader(gl, gl.VERTEX_SHADER, VERT_SRC);
    const frag = compileShader(gl, gl.FRAGMENT_SHADER, FRAG_SRC);
    if (!vert || !frag) return;

    const prog = gl.createProgram();
    if (!prog) return;
    gl.attachShader(prog, vert);
    gl.attachShader(prog, frag);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return;

    gl.useProgram(prog);

    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);

    const posLoc = gl.getAttribLocation(prog, 'position');
    gl.enableVertexAttribArray(posLoc);
    gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);

    const timeLoc = gl.getUniformLocation(prog, 'time');
    const resLoc  = gl.getUniformLocation(prog, 'resolution');

    let rafId = 0;
    let startTime = performance.now();

    const resize = () => {
      canvas.width  = canvas.clientWidth  * devicePixelRatio;
      canvas.height = canvas.clientHeight * devicePixelRatio;
      gl.viewport(0, 0, canvas.width, canvas.height);
    };

    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);

    const frame = (now: number) => {
      rafId = requestAnimationFrame(frame);
      const t = (now - startTime) * 1e-3;
      gl.uniform1f(timeLoc, t);
      gl.uniform2f(resLoc, canvas.width, canvas.height);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };

    rafId = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(rafId);
      ro.disconnect();
      gl.deleteProgram(prog);
      gl.deleteShader(vert);
      gl.deleteShader(frag);
      gl.deleteBuffer(buf);
    };
  }, [canvasRef]);
}

const LOGIN_ERRORS: Record<string, string> = {
  not_in_corp:       'Your character is not a member of the corporation that runs this Nexum instance. Access is restricted to corp members only.',
  corp_check_failed: 'Could not verify your corporation membership due to an ESI error. Please try again in a moment.',
};

export function LandingPage() {
  const [lastChar, setLastChar] = useState<LastCharacter | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useShaderCanvas(canvasRef);

  const errorParam = new URLSearchParams(window.location.search).get('error');
  const errorMessage = errorParam ? (LOGIN_ERRORS[errorParam] ?? 'An unknown error occurred. Please try again.') : null;

  useEffect(() => {
    try {
      // Migrate the older colon-separated key transparently so returning users
      // don't lose their stored last-login chip.
      const stored = localStorage.getItem('nexum.last_character')
        ?? localStorage.getItem('nexum:last_character');
      if (stored) setLastChar(JSON.parse(stored) as LastCharacter);
      localStorage.removeItem('nexum:last_character');
    } catch {}
  }, []);

  return (
    <div className="landing">
      <title>Nexum — EVE Online Wormhole Mapper</title>
      <meta name="description" content="Nexum is a wormhole mapping tool for EVE Online. Track your chain, manage signatures, monitor kills and jumps, and coordinate with your fleet in real time." />
      <meta property="og:title"       content="Nexum — EVE Online Wormhole Mapper" />
      <meta property="og:description" content="Track your wormhole chain, manage signatures, monitor kills and jumps, and coordinate with your fleet in real time." />
      <meta property="og:url"         content="https://eve-nexum.com/" />
      <meta property="og:image"       content="https://eve-nexum.com/hero.png" />
      <meta name="twitter:title"       content="Nexum — EVE Online Wormhole Mapper" />
      <meta name="twitter:description" content="Track your wormhole chain, manage signatures, monitor kills and jumps, and coordinate with your fleet in real time." />

      <header className="landing__header">
        <canvas ref={canvasRef} className="landing__canvas" />
        <div className="landing__header-fade" />
        <div className="landing__logo">◈</div>
        <h1 className="landing__title">Nexum</h1>
        <p className="landing__tagline">Wormhole chain mapping for EVE Online</p>
      </header>

      <div className="landing__content">
                <div className="landing__demo">
          <p className="landing__demo-note">
            ◈ Interactive demo — a simplified preview. Sign in to access signatures, kill feeds, connection tracking, activity history, and more.
          </p>
          <DemoMap />
        </div>

        <div className="landing__cta">
          {errorMessage && (
            <div className="landing__error">
              <span className="landing__error-icon">⚠</span>
              {errorMessage}
            </div>
          )}
          {lastChar ? (
            <>
              <a href={apiUrl('/auth/login')} className="landing__returning">
                <img
                  src={`https://images.evetech.net/characters/${lastChar.characterId}/portrait?size=128`}
                  alt={lastChar.characterName}
                  className="landing__returning-avatar"
                />
                <div className="landing__returning-info">
                  <span className="landing__returning-label">Continue as</span>
                  <span className="landing__returning-name">{lastChar.characterName}</span>
                </div>
              </a>
              <p className="landing__note">
                Session expired — click your portrait to log back in via EVE SSO.
              </p>
              <a href={apiUrl('/auth/login')} className="landing__switch-link">
                Log in as a different character
              </a>
            </>
          ) : (
            <>
              <a href={apiUrl('/auth/login')} className="landing__login-wrap">
                <img
                  src="/vendor/eve-sso-login-white-large.png"
                  alt="Log in with EVE Online"
                  width="270"
                  height="45"
                  className="landing__eve-btn"
                />
              </a>
              <p className="landing__note">
                Secure EVE SSO login — no passwords stored. Character identity only.
              </p>
            </>
          )}
        </div>
        {FEATURE_SECTIONS.map((section) => (
          <section key={section.title} className="landing__section landing__section--features">
            <h2 className="landing__section-title">{section.title}</h2>
            <section className="landing__features">
              {section.items.map((f) => {
                const Icon = f.icon;
                return (
                  <div key={f.title} className="landing__feature">
                    <span className="landing__feature-icon"><Icon size="1em" weight="duotone" /></span>
                    <h3 className="landing__feature-title">{f.title}</h3>
                    <p className="landing__feature-desc">{f.desc}</p>
                  </div>
                );
              })}
            </section>
          </section>
        ))}

        {/* ── Corp / alliance features ───────────────────────── */}
        <section className="landing__section landing__section--features" id="for-corporations">
          <h2 className="landing__section-title">For Corporations</h2>
          <p className="landing__section-body">
            Run Nexum as a shared deployment for your corp or alliance. Members get
            visible-to-the-corp chain maps and private personal maps in one tool, with
            role-based permissions, admin tooling, and per-character activity reporting.
          </p>
          <section className="landing__features">
            {CORP_FEATURES.map((f) => {
              const Icon = f.icon;
              return (
                <div key={f.title} className="landing__feature">
                  <span className="landing__feature-icon"><Icon size="1em" weight="duotone" /></span>
                  <h3 className="landing__feature-title">{f.title}</h3>
                  <p className="landing__feature-desc">{f.desc}</p>
                </div>
              );
            })}
          </section>
        </section>

        {/* ── Compare CTA ───────────────────────────────────── */}
        <section className="landing__section landing__compare">
          <h2 className="landing__section-title">How does Nexum compare?</h2>
          <p className="landing__section-body">
            See how Nexum stacks up against Pathfinder, Tripwire and Wanderer —
            features, hosting and cost, side by side.
          </p>
          <a href="/compare/" className="landing__compare-link">
            Compare Nexum vs Pathfinder, Tripwire &amp; Wanderer →
          </a>
        </section>

        {/* ── About Nexum ───────────────────────────────────── */}
        <section className="landing__section" id="about-nexum">
          <h2 className="landing__section-title">About Nexum</h2>
          <p className="landing__section-body">
            Nexum is a wormhole and exploration tool. It can be used for mapping routes and logging signatures. It was heavily inspired by Pathfinder — but with Pathfinder no longer actively developed (no new release since 2020), rather than complain about it, Nexum was created.
          </p>
          <p className="landing__section-body">
            Nexum is built by a single developer.  I'm adding features as we go but get in contact if you want support or feature requests
          </p>
        </section>

        {/* ── About Me ──────────────────────────────────────── */}
        <section className="landing__section" id="about-me">
          <h2 className="landing__section-title">About Me</h2>
          <div className="landing__about-me">
            <p className="landing__section-body">
              Nexum is written by Addelee as a solo project.  I've played eve since Beta back in 2003. You might see me hanging out in the Help channels or the Scanning channel.  I've played in all areas of space from living in wormholes and thera, running missions in High Sec, gate camping in lowsec and now, null life with Goonswarm.
              <br/><br/>As a day job, I am a programmer and run <a href='https://area404.org' target="_blank" className="landing__faq-link">Area 404</a>.  Because of this, I decided I'd write this tool.  I'm an avid explorer in Eve therefore I wanted a tool that worked for me.
              <br/><br/>Nexum is open source and I welcome anyone to contribute.  I would definitely appreciate feedback and any bugs you encounter so please flag things on <a href="https://github.com/GQuantrill/eve-nexum/issues" target='_blank' className="landing__faq-link"> GitHub</a>
            </p>
            
            <img src={portraitImg} alt="Portrait" className="landing__portrait" />
          </div>
        </section>

        {/* ── Tech Stack ────────────────────────────────────── */}
        <section className="landing__section" id="tech-stack">
          <h2 className="landing__section-title">Tech Stack</h2>
          <p className="landing__section-body">
            Nexum is held together with the finest space-age materials money and caffeine can buy.
            The frontend is <strong>React</strong> with <strong>TypeScript</strong> — because arguing with a compiler
            is still more productive than arguing with a nullsec alliance.
            Maps are rendered with <strong>ReactFlow</strong>, which handles all the node-dragging
            shenanigans so I didn't have to.
            State is managed by <strong>Zustand</strong>, which is delightfully small and has never once
            told me to "just use Redux".
          </p>
          <p className="landing__section-body">
            The backend is <strong>Node.js</strong> with <strong>Express</strong> — proven, boring, and it works.
            Data lives in <strong>PostgreSQL</strong>, seeded with CCP's Static Data Export so Nexum
            actually knows what J213422 is without asking the ESI every five seconds.
            Authentication is handled by <strong>EVE Online SSO</strong> — your credentials never touch
            this server, which is exactly how it should be.
          </p>
          <p className="landing__section-body">
            Live system intelligence comes from the <strong>EVE ESI</strong> (CCP's official API) and kill
            data from <strong>zKillboard</strong>. The whole thing is containerised with <strong>Docker </strong>
             and proxied through <strong>nginx</strong>, because someone has to keep the lights on while
            you're getting evicted from your wormhole.
          </p>
        </section>

        {/* ── FAQs ──────────────────────────────────────────── */}
        <section className="landing__section" id="faqs">
          <h2 className="landing__section-title">FAQs</h2>
          <div className="landing__faq-list">

            <div className="landing__faq-item">
              <h3 className="landing__faq-q">Why Nexum?</h3>
              <p className="landing__faq-a">
                Nexum is the Latin word for a bond or connection — which felt appropriate for a tool built
                around mapping the connections between wormhole systems. It also sounds vaguely like
                something you'd find floating in a C6 magnetar, which was really the deciding factor.
              </p>
            </div>

            <div className="landing__faq-item">
              <h3 className="landing__faq-q">Can I use multiple accounts?</h3>
              <p className="landing__faq-a">
                Yes — each EVE character gets their own set of maps. Just log in with a different character
                via EVE SSO and Nexum will keep their maps completely separate. No cross-contamination,
                no accidental sharing of your super-secret wormhole chain with your alt corp.
              </p>
            </div>

            <div className="landing__faq-item">
              <h3 className="landing__faq-q">Is my data safe?</h3>
              <p className="landing__faq-a">
                Nexum never sees your EVE password — authentication is handled entirely by CCP's EVE SSO.
                The only thing stored is your character identity and the maps you build. Your map data
                lives in a private database and is not shared with anyone. That said, don't use Nexum
                for your alliance's top-secret invasion route — no tool on the internet is a substitute
                for good operational security.
              </p>
            </div>

            <div className="landing__faq-item">
              <h3 className="landing__faq-q">Can I report bugs, add feedback and request features?</h3>
              <p className="landing__faq-a">
                Absolutely. The project is open source on{' '}
                <a href="https://github.com/GQuantrill/eve-nexum" target="_blank" rel="noopener noreferrer" className="landing__faq-link">
                  GitHub
                </a>
                {' '}— open an issue for bugs or feature requests, or submit a pull request if you're feeling
                brave. Feedback via in-game mail to the character tied to this account also works if GitHub
                isn't your thing.
              </p>
            </div>

            <div className="landing__faq-item">
              <h3 className="landing__faq-q">Can I run this myself?</h3>
              <p className="landing__faq-a">
                Yes — Nexum is fully self-hostable. The source is on{' '}
                <a href="https://github.com/GQuantrill/eve-nexum" target="_blank" rel="noopener noreferrer" className="landing__faq-link">
                  GitHub
                </a>
                {' '}and the whole stack spins up with a single <code>docker compose up</code>.
                You'll need to register your own EVE application on the{' '}
                <a href="https://developers.eveonline.com" target="_blank" rel="noopener noreferrer" className="landing__faq-link">
                  CCP developer portal
                </a>
                {' '}to get SSO credentials, but beyond that the README covers everything —
                including importing the EVE static data and pointing Traefik at it if that's your thing.
                If something breaks, open an issue. If you fix it, please open a PR.

                <br/><br/>It isn't the most technical thing to run up but I'd recommend you have basic knownledge of docker and whatever server your running on (Linux?)
              </p>
            </div>

            <div className="landing__faq-item">
              <h3 className="landing__faq-q">But you're a Goon, why would we trust you?</h3>
              <p className="landing__faq-a">
                Fair question, and honestly the correct instinct to have in New Eden. The code is fully
                open source — you're welcome to read every line, run it yourself, or have someone you trust
                audit it. Nexum has no interest in your scouting routes, your corp's killboard shame, or
                whatever you've got parked in that C5. The worst thing a Goon has ever done in a wormhole
                is get evicted from one, and I'd like to help you avoid that fate.
              </p>
            </div>

            <div className="landing__faq-item">
              <h3 className="landing__faq-q">Do you have a roadmap for new features?</h3>
              <p className="landing__faq-a">
                Loosely. Currently the system only works with solo players.  The next logical thing would be to implement this for Corporations and Alliances.  Once I iron out any bugs from this initial launch, I'll start work on that.<br/> This does assume real life work doesn't get in the way!
                <br/><br/>If you have any pressing feature you want, drop me a message ingame and we can chat.
              </p>
            </div>

          </div>
        </section>

        <footer className="landing__footer">
          EVE Online and the EVE logo are the registered trademarks of CCP hf. All rights reserved worldwide.
          Nexum is a third-party tool and is not affiliated with or endorsed by CCP hf. ·{' '}
          <a href="/license/">License &amp; EVE IP notice</a>
        </footer>
      </div>
    </div>
  );
}
