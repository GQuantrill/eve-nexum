import { useEffect, useRef, useState } from 'react';
import { apiUrl } from '../../api/client';

interface LastCharacter { characterId: number; characterName: string; }

const FEATURES = [
  {
    icon: '◈',
    title: 'Wormhole Chain Mapping',
    desc: 'Drag-and-drop interactive map. Add systems, draw connections, and track your wormhole chain in real time.',
  },
  {
    icon: '✦',
    title: 'System Intelligence',
    desc: 'ESI-powered data per system — security status, wormhole class, effects, statics, constellation, NPC type, and sovereignty.',
  },
  {
    icon: '◐',
    title: 'Signature Management',
    desc: 'Paste directly from the probe scanner. Track sig type, wormhole code, and destination — with smart dropdowns showing connected systems.',
  },
  {
    icon: '⚔',
    title: 'Kill Intelligence',
    desc: 'Live zKillboard feed per system. See recent kills with ship, pilot, corporation and alliance — with direct zkillboard links.',
  },
  {
    icon: '⟷',
    title: 'Connection Tracking',
    desc: 'Monitor wormhole mass and time status on every connection. Mark connections as stable, destabilised, or critical.',
  },
  {
    icon: '⊕',
    title: 'Secure EVE SSO',
    desc: 'Log in with EVE Online SSO. No passwords stored — only your character identity is used to personalise your map.',
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

export function LandingPage() {
  const [lastChar, setLastChar] = useState<LastCharacter | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useShaderCanvas(canvasRef);

  useEffect(() => {
    try {
      const stored = localStorage.getItem('nexum:last_character');
      if (stored) setLastChar(JSON.parse(stored) as LastCharacter);
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

        <div className="landing__cta">
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

        <footer className="landing__footer">
          Nexum is not affiliated with CCP Games or EVE Online.
        </footer>
      </div>
    </div>
  );
}
