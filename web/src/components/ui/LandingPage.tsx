import { useEffect, useRef, useState } from 'react';
import { charPortrait } from '../../utils/eveImages';
import { Trans, useTranslation } from 'react-i18next';
import type { Icon } from '@phosphor-icons/react';
import {
  GraphIcon, MapTrifoldIcon, GaugeIcon, MagnifyingGlassIcon, SelectionIcon, ImageIcon, HourglassIcon,
  UsersIcon, UsersThreeIcon, StackIcon, ArrowsMergeIcon, ArrowsClockwiseIcon, LockIcon, ShieldCheckIcon,
  CardsIcon, WaveformIcon, BuildingsIcon, SparkleIcon, ChartLineIcon, FlagBannerIcon, SwordIcon, HandshakeIcon,
  PathIcon, StarIcon, SnowflakeIcon, LightningIcon, WarningIcon, NavigationArrowIcon, MapPinIcon, BroadcastIcon, BellRingingIcon, DiscordLogoIcon,
  CommandIcon, HouseIcon, SkullIcon, ChartBarIcon, PulseIcon, EyeIcon, SidebarIcon,
  SquaresFourIcon, UserGearIcon, TableIcon, ChartDonutIcon, ClockIcon, ClipboardTextIcon, TagIcon, IdentificationCardIcon,
} from '@phosphor-icons/react';
import { apiUrl } from '../../api/client';
import { SUPPORTED_LANGUAGES, LANGUAGE_NAMES } from '../../i18n';
import { DemoMap } from './DemoMap';
import { LanguageSwitcher } from './LanguageSwitcher';
import { LangFlag } from './LangFlag';
import portraitImg from '../../assets/portrait.jpeg';
interface LastCharacter { characterId: number; characterName: string; }

// Categorised feature sections that mirror the README's Key features tree.
// Cards still render through the same `landing__feature` template; each
// section gets a heading rendered above its grid. Titles and descriptions
// live in the `landing` i18n namespace, keyed by these ids.
type SectionId = 'mapping' | 'personalCorp' | 'sysIntel' | 'liveOps' | 'productivity';
type FeatureId =
  | 'interactiveMap' | 'seedRegion' | 'whIntel' | 'rollingCalc' | 'whPicker'
  | 'multiSelect' | 'pngExport' | 'sigAging'
  | 'soloCorp' | 'multiCharacter' | 'multiMap' | 'mergeMaps' | 'realtime' | 'mapLocking' | 'rbac'
  | 'systemPanel' | 'sigMgmt' | 'structImport' | 'autoStruct' | 'activityCharts'
  | 'sovStation' | 'killboard' | 'effectDigest' | 'standings'
  | 'scout' | 'a0' | 'iceBelt' | 'storms' | 'proximity' | 'discordNotif'
  | 'routePlanner' | 'locationTracking' | 'presence' | 'onlineStatus'
  | 'commandPalette' | 'homeHotkey' | 'killHighlights' | 'userStats'
  | 'serverStatus' | 'demoMap' | 'sidebar';
type CorpFeatureId =
  | 'multiCorp' | 'adminDash' | 'userMgmt' | 'mapMgmt' | 'usersReport'
  | 'systemsReport' | 'timeWindowed' | 'auditLog' | 'corpTicker' | 'perCharAttr';

interface FeatureItem { icon: Icon; id: FeatureId }
interface FeatureSection { id: SectionId; items: FeatureItem[] }

const FEATURE_SECTIONS: FeatureSection[] = [
  {
    id: 'mapping',
    items: [
      { icon: GraphIcon,           id: 'interactiveMap' },
      { icon: MapTrifoldIcon,      id: 'seedRegion'     },
      { icon: GaugeIcon,           id: 'whIntel'        },
      { icon: ArrowsClockwiseIcon, id: 'rollingCalc'    },
      { icon: MagnifyingGlassIcon, id: 'whPicker'       },
      { icon: SelectionIcon,       id: 'multiSelect'    },
      { icon: ImageIcon,           id: 'pngExport'      },
      { icon: HourglassIcon,       id: 'sigAging'       },
    ],
  },
  {
    id: 'personalCorp',
    items: [
      { icon: UsersIcon,       id: 'soloCorp'       },
      { icon: UsersThreeIcon,  id: 'multiCharacter' },
      { icon: StackIcon,       id: 'multiMap'       },
      { icon: ArrowsMergeIcon, id: 'mergeMaps'  },
      { icon: BroadcastIcon,   id: 'realtime'   },
      { icon: LockIcon,        id: 'mapLocking' },
      { icon: ShieldCheckIcon, id: 'rbac'       },
    ],
  },
  {
    id: 'sysIntel',
    items: [
      { icon: CardsIcon,      id: 'systemPanel'    },
      { icon: WaveformIcon,   id: 'sigMgmt'        },
      { icon: BuildingsIcon,  id: 'structImport'   },
      { icon: SparkleIcon,    id: 'autoStruct'     },
      { icon: ChartLineIcon,  id: 'activityCharts' },
      { icon: FlagBannerIcon, id: 'sovStation'     },
      { icon: SwordIcon,      id: 'killboard'      },
      { icon: SparkleIcon,    id: 'effectDigest'   },
      { icon: HandshakeIcon,  id: 'standings'      },
    ],
  },
  {
    id: 'liveOps',
    items: [
      { icon: PathIcon,            id: 'scout'            },
      { icon: StarIcon,            id: 'a0'               },
      { icon: SnowflakeIcon,       id: 'iceBelt'          },
      { icon: LightningIcon,       id: 'storms'           },
      { icon: WarningIcon,         id: 'proximity'        },
      { icon: BellRingingIcon,     id: 'discordNotif'     },
      { icon: NavigationArrowIcon, id: 'routePlanner'     },
      { icon: MapPinIcon,          id: 'locationTracking' },
      { icon: UsersIcon,           id: 'presence'         },
      { icon: BroadcastIcon,       id: 'onlineStatus'     },
    ],
  },
  {
    id: 'productivity',
    items: [
      { icon: CommandIcon,  id: 'commandPalette' },
      { icon: HouseIcon,    id: 'homeHotkey'     },
      { icon: SkullIcon,    id: 'killHighlights' },
      { icon: ChartBarIcon, id: 'userStats'      },
      { icon: PulseIcon,    id: 'serverStatus'   },
      { icon: EyeIcon,      id: 'demoMap'        },
      { icon: SidebarIcon,  id: 'sidebar'        },
    ],
  },
];

// "For corporations" section in the README mirrored here. Hidden behind
// CORP_ID at the deployment level; admin-only at the UI level.
const CORP_FEATURES: { icon: Icon; id: CorpFeatureId }[] = [
  { icon: BuildingsIcon,          id: 'multiCorp'     },
  { icon: SquaresFourIcon,        id: 'adminDash'     },
  { icon: UserGearIcon,           id: 'userMgmt'      },
  { icon: MapTrifoldIcon,         id: 'mapMgmt'       },
  { icon: TableIcon,              id: 'usersReport'   },
  { icon: ChartDonutIcon,         id: 'systemsReport' },
  { icon: ClockIcon,              id: 'timeWindowed'  },
  { icon: ClipboardTextIcon,      id: 'auditLog'      },
  { icon: TagIcon,                id: 'corpTicker'    },
  { icon: IdentificationCardIcon, id: 'perCharAttr'   },
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
    const startTime = performance.now();

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

// Map a login ?error= param to a typed translation key so the lookup stays
// type-safe; anything unrecognised falls back to the generic message.
function loginErrorKey(param: string): 'landing.errors.not_in_corp' | 'landing.errors.corp_check_failed' | 'landing.errors.unknown' {
  if (param === 'not_in_corp')       return 'landing.errors.not_in_corp';
  if (param === 'corp_check_failed') return 'landing.errors.corp_check_failed';
  return 'landing.errors.unknown';
}

export function LandingPage() {
  const { t } = useTranslation();
  // Read the stored last-login chip eagerly so it paints on first render (no
  // null -> value flash). Also reads the older colon-separated key so returning
  // users don't lose their chip; that legacy key is cleaned up in the effect below.
  const [lastChar] = useState<LastCharacter | null>(() => {
    try {
      const stored = localStorage.getItem('nexum.last_character')
        ?? localStorage.getItem('nexum:last_character');
      return stored ? (JSON.parse(stored) as LastCharacter) : null;
    } catch {
      // localStorage may be unavailable or hold malformed JSON — fall back to none.
      return null;
    }
  });
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useShaderCanvas(canvasRef);

  const errorParam = new URLSearchParams(window.location.search).get('error');
  const errorMessage = errorParam ? t(loginErrorKey(errorParam)) : null;

  // One-time migration: drop the older colon-separated key now that its value
  // (if any) has been folded into state above.
  useEffect(() => {
    try {
      localStorage.removeItem('nexum:last_character');
    } catch {
      // ignore — storage may be unavailable (private mode, etc.)
    }
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
        <div style={{ position: 'absolute', top: 16, right: 16, zIndex: 3 }}>
          <LanguageSwitcher />
        </div>
        <div className="landing__logo">◈</div>
        <h1 className="landing__title">Nexum</h1>
        <p className="landing__tagline">{t('landing.tagline')}</p>
      </header>

      <div className="landing__content">
                <div className="landing__demo">
          <p className="landing__demo-note">
            {t('landing.demoNote')}
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
                  src={charPortrait(lastChar.characterId, 128)}
                  alt={lastChar.characterName}
                  className="landing__returning-avatar"
                />
                <div className="landing__returning-info">
                  <span className="landing__returning-label">{t('landing.cta.continueAs')}</span>
                  <span className="landing__returning-name">{lastChar.characterName}</span>
                </div>
              </a>
              <p className="landing__note">
                {t('landing.cta.sessionExpired')}
              </p>
              <a href={apiUrl('/auth/login')} className="landing__switch-link">
                {t('landing.cta.switchChar')}
              </a>
            </>
          ) : (
            <>
              <a href={apiUrl('/auth/login')} className="landing__login-wrap">
                <img
                  src="/vendor/eve-sso-login-white-large.png"
                  alt={t('landing.cta.loginAlt')}
                  width="270"
                  height="45"
                  className="landing__eve-btn"
                />
              </a>
              <p className="landing__note">
                {t('landing.cta.secureLogin')}
              </p>
            </>
          )}
          <a
            href="https://discord.gg/KG8SMXrhZ4"
            target="_blank"
            rel="noopener noreferrer"
            className="landing__discord-btn"
          >
            <DiscordLogoIcon size={20} weight="fill" />
            <span>{t('landing.cta.joinDiscord')}</span>
          </a>
        </div>
        {FEATURE_SECTIONS.map((section) => (
          <section key={section.id} className="landing__section landing__section--features">
            <h2 className="landing__section-title">{t(`landing.sections.${section.id}`)}</h2>
            <section className="landing__features">
              {section.items.map((f) => {
                const Icon = f.icon;
                return (
                  <div key={f.id} className="landing__feature">
                    <span className="landing__feature-icon"><Icon size="1em" weight="duotone" /></span>
                    <h3 className="landing__feature-title">{t(`landing.features.${f.id}.title`)}</h3>
                    <p className="landing__feature-desc">{t(`landing.features.${f.id}.desc`)}</p>
                  </div>
                );
              })}
            </section>
          </section>
        ))}

        {/* ── Corp / alliance features ───────────────────────── */}
        <section className="landing__section landing__section--features" id="for-corporations">
          <h2 className="landing__section-title">{t('landing.sections.forCorps')}</h2>
          <p className="landing__section-body">
            {t('landing.forCorpsBody')}
          </p>
          <section className="landing__features">
            {CORP_FEATURES.map((f) => {
              const Icon = f.icon;
              return (
                <div key={f.id} className="landing__feature">
                  <span className="landing__feature-icon"><Icon size="1em" weight="duotone" /></span>
                  <h3 className="landing__feature-title">{t(`landing.corpFeatures.${f.id}.title`)}</h3>
                  <p className="landing__feature-desc">{t(`landing.corpFeatures.${f.id}.desc`)}</p>
                </div>
              );
            })}
          </section>
        </section>

        {/* ── Multi-lingual ─────────────────────────────────── */}
        <section className="landing__section landing__languages" id="languages">
          <h2 className="landing__section-title">{t('landing.sections.languages')}</h2>
          <p className="landing__section-body">
            {t('landing.languagesBody')}
          </p>
          <ul className="landing__lang-list">
            {SUPPORTED_LANGUAGES.map((lng) => (
              <li key={lng} className="landing__lang-chip">
                <LangFlag lang={lng} className="landing__lang-flag" />
                {LANGUAGE_NAMES[lng]}
              </li>
            ))}
          </ul>
        </section>

        {/* ── Compare CTA ───────────────────────────────────── */}
        <section className="landing__section landing__compare">
          <h2 className="landing__section-title">{t('landing.sections.compare')}</h2>
          <p className="landing__section-body">
            {t('landing.compareBody')}
          </p>
          <a href="/compare/" className="landing__compare-link">
            {t('landing.compareLink')}
          </a>
        </section>

        {/* ── Discord CTA ──────────────────────────────────── */}
        <section className="landing__section landing__compare">
          <h2 className="landing__section-title">{t('landing.sections.discordCta')}</h2>
          <p className="landing__section-body">
            {t('landing.discordCtaBody')}
          </p>
          <a
            href="https://discord.gg/KG8SMXrhZ4"
            target="_blank"
            rel="noopener noreferrer"
            className="landing__discord-btn"
          >
            <DiscordLogoIcon size={20} weight="fill" />
            <span>{t('landing.cta.joinDiscord')}</span>
          </a>
        </section>

        {/* ── About Nexum ───────────────────────────────────── */}
        <section className="landing__section" id="about-nexum">
          <h2 className="landing__section-title">{t('landing.sections.about')}</h2>
          <p className="landing__section-body">
            {t('landing.aboutBody1')}
          </p>
          <p className="landing__section-body">
            {t('landing.aboutBody2')}
          </p>
        </section>

        {/* ── About Me ──────────────────────────────────────── */}
        <section className="landing__section" id="about-me">
          <h2 className="landing__section-title">{t('landing.sections.aboutMe')}</h2>
          <div className="landing__about-me">
            <p className="landing__section-body">
              <Trans
                i18nKey="landing.aboutMe"
                components={{
                  area404: <a href="https://area404.org" target="_blank" rel="noopener noreferrer" className="landing__faq-link" />,
                  gh: <a href="https://github.com/GQuantrill/eve-nexum/issues" target="_blank" rel="noopener noreferrer" className="landing__faq-link" />,
                }}
              />
            </p>

            <img src={portraitImg} alt="Portrait" className="landing__portrait" />
          </div>
        </section>

        {/* ── Tech Stack ────────────────────────────────────── */}
        <section className="landing__section" id="tech-stack">
          <h2 className="landing__section-title">{t('landing.sections.techStack')}</h2>
          <p className="landing__section-body">
            <Trans i18nKey="landing.techStack1" />
          </p>
          <p className="landing__section-body">
            <Trans i18nKey="landing.techStack2" />
          </p>
          <p className="landing__section-body">
            <Trans i18nKey="landing.techStack3" />
          </p>
        </section>

        {/* ── FAQs ──────────────────────────────────────────── */}
        <section className="landing__section" id="faqs">
          <h2 className="landing__section-title">{t('landing.sections.faqs')}</h2>
          <div className="landing__faq-list">

            <div className="landing__faq-item">
              <h3 className="landing__faq-q">{t('landing.faq.whyNexum.q')}</h3>
              <p className="landing__faq-a">
                {t('landing.faq.whyNexum.a')}
              </p>
            </div>

            <div className="landing__faq-item">
              <h3 className="landing__faq-q">{t('landing.faq.multipleAccounts.q')}</h3>
              <p className="landing__faq-a">
                {t('landing.faq.multipleAccounts.a')}
              </p>
            </div>

            <div className="landing__faq-item">
              <h3 className="landing__faq-q">{t('landing.faq.dataSafe.q')}</h3>
              <p className="landing__faq-a">
                {t('landing.faq.dataSafe.a')}
              </p>
            </div>

            <div className="landing__faq-item">
              <h3 className="landing__faq-q">{t('landing.faq.reportBugs.q')}</h3>
              <p className="landing__faq-a">
                <Trans
                  i18nKey="landing.faq.reportBugs.a"
                  components={{
                    gh: <a href="https://github.com/GQuantrill/eve-nexum" target="_blank" rel="noopener noreferrer" className="landing__faq-link" />,
                  }}
                />
              </p>
            </div>

            <div className="landing__faq-item">
              <h3 className="landing__faq-q">{t('landing.faq.runYourself.q')}</h3>
              <p className="landing__faq-a">
                <Trans
                  i18nKey="landing.faq.runYourself.a"
                  components={{
                    gh: <a href="https://github.com/GQuantrill/eve-nexum" target="_blank" rel="noopener noreferrer" className="landing__faq-link" />,
                    devportal: <a href="https://developers.eveonline.com" target="_blank" rel="noopener noreferrer" className="landing__faq-link" />,
                    code: <code />,
                  }}
                />
              </p>
            </div>

            <div className="landing__faq-item">
              <h3 className="landing__faq-q">{t('landing.faq.goonTrust.q')}</h3>
              <p className="landing__faq-a">
                {t('landing.faq.goonTrust.a')}
              </p>
            </div>

            <div className="landing__faq-item">
              <h3 className="landing__faq-q">{t('landing.faq.roadmap.q')}</h3>
              <p className="landing__faq-a">
                <Trans i18nKey="landing.faq.roadmap.a" />
              </p>
            </div>
             <div className="landing__faq-item">
              <h3 className="landing__faq-q">{t('landing.faq.donateIsk.q')}</h3>
              <p className="landing__faq-a">
                {t('landing.faq.donateIsk.a')}
              </p>
            </div>

          </div>
        </section>

        <footer className="landing__footer">
          <Trans
            i18nKey="landing.footer"
            components={{ license: <a href="/license/" /> }}
          />
        </footer>
      </div>
    </div>
  );
}
