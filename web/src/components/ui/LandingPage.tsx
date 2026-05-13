import { useEffect, useRef, useState } from 'react';
import { apiUrl } from '../../api/client';
import { DemoMap } from './DemoMap';
import menuImg from '../../assets/Menu.png';
import quickSystemImg from '../../assets/quick-system.png';
import showSigsImg from '../../assets/show-sigs.png';
import portraitImg from '../../assets/portrait.jpeg';
interface LastCharacter { characterId: number; characterName: string; }

const FEATURES = [
  {
    icon: '◎',
    title: 'Live Character Tracking',
    desc: 'Your current system updates across the EVE universe every 10 seconds via ESI. New systems appear on your map automatically and link back to where you came from.',
  },
  {
    icon: '◐',
    title: 'Signature Capture',
    desc: 'Paste straight from the probe scanner. Sig IDs, wormhole codes, destinations, and timestamps are kept across sessions — ready to use again later.',
  },
  {
    icon: '⊞',
    title: 'NPC Station Information',
    desc: 'Per-system station list with available services and owning corporation. Set destination or add a waypoint in one click.',
  },
  {
    icon: '⚔',
    title: 'zKill Integration',
    desc: 'Live recent-kill feed per system — ship, pilot, corporation, alliance — with direct links back to zkillboard.com.',
  },
  {
    icon: '✦',
    title: 'Thera Connections',
    desc: 'EVE-Scout\'s live Thera signature list in your sidebar, sorted by jumps from your current location. Route preview and one-click destination set.',
  },
  {
    icon: '✦',
    title: 'Turnur Connections',
    desc: 'The same live coverage for Turnur, sorted by jumps from your location. Pre-plan your route in or out without scanning.',
  },
  {
    icon: '★',
    title: 'Find Your Closest A0 Sun',
    desc: 'The 10 nearest A0 (Blue Small) suns to your current system, sorted by stargate jumps. Set destination or add a waypoint instantly.',
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
      <meta property="og:url"         content="https://nexum.area404.org/" />
      <meta property="og:image"       content="https://nexum.area404.org/hero.png" />
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
        <section className="landing__features">
          {FEATURES.map((f) => (
            <div key={f.title} className="landing__feature">
              <span className="landing__feature-icon">{f.icon}</span>
              <h3 className="landing__feature-title">{f.title}</h3>
              <p className="landing__feature-desc">{f.desc}</p>
            </div>
          ))}
        </section>

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
                  src="https://web.ccpgamescdn.com/eveonlineassets/developers/eve-sso-login-white-large.png"
                  alt="Log in with EVE Online"
                  className="landing__eve-btn"
                />
              </a>
              <p className="landing__note">
                Secure EVE SSO login — no passwords stored. Character identity only.
              </p>
            </>
          )}
        </div>

        {/* ── About Nexum ───────────────────────────────────── */}
        <section className="landing__section" id="about-nexum">
          <h2 className="landing__section-title">About Nexum</h2>
          <p className="landing__section-body">
            Nexum is a wormhole and exploration tool.  It can be used for mapping routes and logging signatures. It was heavily inspired by Pathfinder but as this is no longer in development.
            Because of this, rather than complain about it, Nexum was created.
          </p>
          <p className="landing__section-body">Key Features
            <ul>
              <li>Dynamic mapping based on where you character is in eve.  The map updates when you move from system to system</li>
              <li>Store Signatures against the systems.  Don't waste time re-scanning already known sigs</li>
              <li>See Wormhole effects at a glance</li>
              <li>See which systems have NPC stations and which services are offered there</li>
              <li>zKillboard integration</li>
            </ul>
            <div className="landing__screenshot-grid">
              <figure className="landing__screenshot-figure">
                <img src={menuImg} alt="System menu" className="landing__screenshot landing__screenshot--sm" />
                <figcaption className="landing__screenshot-caption">Easy to customize options</figcaption>
              </figure>
              <figure className="landing__screenshot-figure">
                <img src={quickSystemImg} alt="Quick system add" className="landing__screenshot" />
                <figcaption className="landing__screenshot-caption">See key data at a glance</figcaption>
              </figure>
            </div>
            <div className="landing__screenshot-single">
              <p className="landing__screenshot-subtitle">You can copy and paste signatures directly from the Probe scanner in Eve</p>
              <figure className="landing__screenshot-figure">
                <img src={showSigsImg} alt="Signature panel" className="landing__screenshot" />
                <figcaption className="landing__screenshot-caption">Cut and paste signatures from game to map</figcaption>
              </figure>
            </div>
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
          Nexum is not affiliated with Fenris Creations or EVE Online.
        </footer>
      </div>
    </div>
  );
}
