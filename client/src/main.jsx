import React, { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation, useNavigate, useParams, Link } from 'react-router-dom';
import { Activity, ArrowDownRight, ArrowRight, ArrowUpRight, Bell, CalendarDays, ChevronDown, CircleHelp, Compass, Crosshair, Gamepad2, Globe2, Image, LogOut, Menu, Search, ShieldCheck, BadgeCheck, Swords, Trophy, Users, X, Zap } from 'lucide-react';
import { api, dateTime, money, send } from './api.js';
import { OGSymbol, XPSymbol } from './points-symbols.jsx';
import { useFakeRegistrationDisplayCount } from './tournament-display.js';
import { AdminPanel, Leaderboard, PlayerSearch, PublicPlayer, PublicProfileView, ShieldBadge, Support } from './extended-pages.jsx';
import './styles.css';
import ReactMarkdown from 'react-markdown';

const AuthContext = createContext(null);
const useAuth = () => useContext(AuthContext);
const useData = (loader, deps = []) => {
  const [state, setState] = useState({ loading: true, data: null, error: '' });
  useEffect(() => { let alive = true; setState((s) => ({ ...s, loading: true, error: '' })); loader().then((data) => alive && setState({ loading: false, data, error: '' })).catch((error) => alive && setState({ loading: false, data: null, error: error.message })); return () => { alive = false; }; }, deps);
  return state;
};

function App() {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);
  const [toast, setToast] = useState('');
  useEffect(() => { api('/auth/me').then((value) => setUser(value.user)).catch(() => {}).finally(() => setReady(true)); }, []);
  const auth = useMemo(() => ({ user, setUser, toast: (message) => { setToast(message); window.setTimeout(() => setToast(''), 3000); } }), [user]);
  return <AuthContext.Provider value={auth}><BrowserRouter><ScrollReset /><Routes>
    <Route element={<PublicLayout />}>
      <Route path="/" element={<Home />} /><Route path="/tournaments" element={<Tournaments />} /><Route path="/tournaments/:slug" element={<TournamentDetail />} />
      <Route path="/leaderboard" element={<Leaderboard />} /><Route path="/players" element={<PlayerSearch />} /><Route path="/players/:username" element={<PublicPlayer user={user} toast={auth.toast} />} />
      <Route path="/login" element={<Login />} /><Route path="/register" element={<Register />} /><Route path="/verify-email" element={<VerifyEmail />} />
      <Route path="/forgot-password" element={<ForgotPassword />} /><Route path="/reset-password" element={<ResetPassword />} />
      <Route path="/terms" element={<LegalPage kind="terms" />} /><Route path="/privacy" element={<LegalPage kind="privacy" />} />
      <Route path="/pass/ads" element={<Login adminMode />} />
      <Route path="/arena" element={<Gate user={user} ready={ready} role="player"><PlayerDashboard /></Gate>} />
      <Route path="/profile" element={<Gate user={user} ready={ready} role="player"><Profile /></Gate>} />
      <Route path="/security" element={<Gate user={user} ready={ready} role="player"><PasswordChange /></Gate>} />
      <Route path="/notifications" element={<Gate user={user} ready={ready} role="player"><Notifications /></Gate>} />
      <Route path="/teams" element={<Gate user={user} ready={ready} role="player"><Teams /></Gate>} />
      <Route path="/matches" element={<Gate user={user} ready={ready} role="player"><Matches /></Gate>} />
      <Route path="/rewards" element={<Gate user={user} ready={ready} role="player"><Rewards /></Gate>} />
      <Route path="/payments" element={<Gate user={user} ready={ready} role="player"><PlayerPayments toast={auth.toast} /></Gate>} />
      <Route path="/support" element={<Gate user={user} ready={ready} role="player"><Support toast={auth.toast} /></Gate>} />
      <Route path="/pass/ads/dashboard" element={<Gate user={user} ready={ready} role="admin"><AdminPanel section="overview" /></Gate>} />
      <Route path="/pass/ads/players" element={<Gate user={user} ready={ready} role="admin"><AdminPanel section="players" /></Gate>} />
      <Route path="/pass/ads/games" element={<Gate user={user} ready={ready} role="admin"><AdminPanel section="games" /></Gate>} />
      <Route path="/pass/ads/tournaments" element={<Gate user={user} ready={ready} role="admin"><AdminPanel section="tournaments" /></Gate>} />
      <Route path="/pass/ads/registrations" element={<Gate user={user} ready={ready} role="admin"><AdminPanel section="registrations" /></Gate>} />
      <Route path="/pass/ads/matches" element={<Gate user={user} ready={ready} role="admin"><AdminPanel section="matches" /></Gate>} />
      <Route path="/pass/ads/teams" element={<Gate user={user} ready={ready} role="admin"><AdminPanel section="teams" /></Gate>} />
      <Route path="/pass/ads/support" element={<Gate user={user} ready={ready} role="admin"><AdminPanel section="support" /></Gate>} />
      <Route path="/pass/ads/payments" element={<Gate user={user} ready={ready} role="admin"><AdminPanel section="payments" /></Gate>} />
      <Route path="/pass/ads/site" element={<Gate user={user} ready={ready} role="admin"><AdminPanel section="site" /></Gate>} />
      <Route path="/pass/ads/assets" element={<Gate user={user} ready={ready} role="admin"><AdminPanel section="assets" /></Gate>} />
      <Route path="/pass/ads/analytics" element={<Gate user={user} ready={ready} role="admin"><AdminPanel section="analytics" /></Gate>} />
      <Route path="*" element={<NotFound />} />
    </Route>
  </Routes>{toast && <div className="toast" role="status">{toast}</div>}</BrowserRouter></AuthContext.Provider>;
}

function ScrollReset() { const { pathname } = useLocation(); useEffect(() => { window.scrollTo({ top: 0, behavior: 'instant' }); }, [pathname]); return null; }
function Gate({ user, ready, role, children }) { const location = useLocation(); if (!ready) return <div className="page-loading"><span className="loader" />Loading your arena…</div>; if (!user) return <Navigate to={role === 'admin' ? '/pass/ads' : '/login'} state={{ from: location.pathname }} replace />; if (user.role !== role) return <Navigate to={user.role === 'admin' ? '/pass/ads/dashboard' : '/arena'} replace />; return children; }

function Brand({ compact = false }) { return <Link className={`brand ${compact ? 'brand-compact' : ''}`} to="/" aria-label="Ocean Edge Games home"><span className="brand-mark"><img src="/images/oeg-emblem.png" alt="" /></span><span className="brand-name">OCEAN EDGE <b>GAMES</b></span></Link>; }
function PublicLayout() {
  const { user, setUser, toast } = useAuth(); const [open, setOpen] = useState(false); const location = useLocation();
  useEffect(() => setOpen(false), [location.pathname]);
  const logout = async () => { try { await send('/auth/logout', {}); } finally { setUser(null); toast('You have signed out.'); } };
  return <><header className="site-header"><div className="shell header-inner"><Brand /><button className="mobile-menu" aria-label="Toggle navigation" onClick={() => setOpen(!open)}>{open ? <X /> : <Menu />}</button><nav className={open ? 'main-nav is-open' : 'main-nav'}>
    <Link to="/tournaments">Tournaments</Link><Link to="/leaderboard">Leaderboard</Link><Link to="/players">Players</Link>
    {user ? <><Link className="nav-arena" to={user.role === 'admin' ? '/pass/ads/dashboard' : '/arena'}>{user.role === 'admin' ? 'Console' : 'Arena Hub'} <ArrowUpRight size={14} /></Link><button className="nav-text-button" onClick={logout}>Sign out</button></> : <><Link to="/login" className="nav-login">Log in</Link><Link to="/register" className="button button-small">Create account <ArrowRight size={14} /></Link></>}
  </nav></div></header>{user?.role==='player'&&<PlayerSubnav/>}<main><Outlet /></main><Footer /></>;
}

function PlayerSubnav(){return <div className="player-subnav"><nav className="shell">{[['/arena','Arena Hub'],['/tournaments','Tournaments'],['/teams','My Team'],['/matches','Matches'],['/rewards','Earned'],['/payments','Payments'],['/profile','Profile'],['/security','Security'],['/support','Support']].map(([to,label])=><Link to={to} key={to}>{label}</Link>)}</nav></div>;}

function Footer() { return <footer className="footer"><div className="shell footer-top"><div><Brand /><p>For the ones who queue up<br />and show up.</p></div><div className="footer-links"><div><span className="eyebrow">EXPLORE</span><Link to="/tournaments">Tournaments</Link><Link to="/leaderboard">Leaderboard</Link><Link to="/players">Players</Link></div><div><span className="eyebrow">THE PLATFORM</span><Link to="/terms">Terms & conditions</Link><Link to="/privacy">Privacy policy</Link><Link to="/support">Support</Link></div></div></div><div className="shell footer-bottom"><span>© {new Date().getFullYear()} Ocean Edge Games</span><span className="footer-location"><span className="status-dot" /> Built for the arena</span></div></footer>; }

function Eyebrow({ children, icon: Icon }) { return <div className="eyebrow">{Icon && <Icon size={13} />}{children}</div>; }
function SectionHeading({ overline, title, copy, action }) { return <div className="section-heading"><div><Eyebrow>{overline}</Eyebrow><h2>{title}</h2>{copy && <p>{copy}</p>}</div>{action}</div>; }
function StatusPill({ children, tone = 'default' }) { return <span className={`status-pill status-${tone}`}><span />{children}</span>; }

function EmptyState({ title = 'Nothing here yet', copy = 'New updates will appear here when they are available.', icon: Icon = Activity }) { return <div className="empty-state"><span className="empty-icon"><Icon size={21} /></span><strong>{title}</strong><p>{copy}</p></div>; }
function Loading() { return <div className="loading-inline"><span className="loader" />Loading…</div>; }
function ErrorState({ message, retry }) { return <div className="error-state"><strong>Couldn’t load this right now</strong><p>{message}</p>{retry && <button className="button button-ghost button-small" onClick={retry}>Try again</button>}</div>; }
function moneyOrFree(paise) { return Number(paise) > 0 ? money(paise) : 'Free entry'; }

function Home() {
  const tournaments = useData(() => api('/tournaments?limit=3').then((v) => v.data));
  const games = useData(() => api('/games').then((v) => v.data));
  const boards = useData(() => api('/leaderboard?limit=3').then((v) => v.data));
  const results = useData(() => api('/results').then((v) => v.data));
  const upcoming = (tournaments.data || []).filter((t) => ['registration_open','registration_not_open','registration_full','registration_closed','started','ongoing'].includes(t.status)).slice(0,3);
  return <>
    <section className="hero"><div className="hero-grid shell"><div className="hero-copy"><Eyebrow icon={Crosshair}>THE NEXT MATCH STARTS HERE</Eyebrow><h1>PLAY.<br /><em>COMPETE.</em><br />BELONG.</h1><p className="hero-lede">Find your squad. Enter the bracket. Make every round count.</p><div className="hero-actions"><Link className="button" to="/tournaments">Explore tournaments <ArrowRight size={16} /></Link><Link className="text-link" to="/register">Build your profile <ArrowUpRight size={16} /></Link></div><div className="hero-note"><span className="status-dot" />A home for competitive play</div></div><HeroArt /></div><div className="hero-bottom shell"><div><span className="hero-index">01</span><span>Play with purpose</span></div><div><span className="hero-index">02</span><span>Earn your place</span></div><div><span className="hero-index">03</span><span>Find your people</span></div><span className="hero-coordinate">19°04' N&nbsp; 72°52' E</span></div></section>
    <section className="section shell section-tournaments"><SectionHeading overline="THE OPEN BRACKET" title="Find your next game." copy="Real tournaments, real stakes. See what's open and what's coming up." action={<Link className="text-link" to="/tournaments">All tournaments <ArrowRight size={15} /></Link>} />
      {tournaments.loading ? <Loading /> : tournaments.error ? <ErrorState message={tournaments.error} /> : upcoming.length ? <div className="tournament-grid">{upcoming.map((t, i) => <TournamentCard key={t.id} tournament={t} index={i} />)}</div> : <EmptyState title="The next bracket is taking shape" copy="There are no published tournaments available yet. Check back soon." icon={Swords} />}
    </section>
    <section className="section section-dark"><div className="shell"><SectionHeading overline="SUPPORTED GAMES" title="Your game. Your arena." copy="The game and formats configured for upcoming competition." action={<Link className="text-link" to="/tournaments">Browse formats <ArrowRight size={15} /></Link>} />
      {games.loading ? <Loading /> : games.error ? <ErrorState message={games.error} /> : games.data?.length ? <div className="game-list">{games.data.map((game,index)=><Link className="game-row" to={`/tournaments?game=${game.slug}`} key={game.id}><span className="game-index">0{index+1}</span><span className={`game-symbol symbol-${index%3}`}><Gamepad2 size={21}/></span><span className="game-title"><strong>{game.name}</strong><small>{game.formats.map((f)=>f.name).join(' / ') || 'Formats being configured'}</small></span><span className="game-description">{game.description}</span><ArrowUpRight className="game-arrow" size={19}/></Link>)}</div> : <EmptyState title="Games are being configured" copy="Published games and formats will show here." icon={Gamepad2} />}
    </div></section>
    <section className="section section-dark"><div className="shell"><SectionHeading overline="RECENT RESULTS" title="The last round." copy="Published match placements from completed competition." action={<Link className="text-link" to="/leaderboard">Points & rankings <ArrowRight size={15}/></Link>}/>{results.loading?<Loading/>:results.error?<ErrorState message={results.error}/>:results.data.length?<div className="result-strip">{results.data.map(r=><div className="result-card" key={`${r.match_id}-${r.participant}`}><span className="result-place">{r.placement===0?'CONTENDER':`#${r.placement}`}</span><div><strong>{r.participant}</strong><small>{r.match_title} · {r.game_name}</small><small>{r.tournament_name} · {dateTime(r.scheduled_at)}</small></div><Trophy size={17}/></div>)}</div>:<EmptyState title="First results are still ahead" copy="Completed and finalized results will appear here." icon={Trophy}/>}</div></section>
    <section className="section shell leader-section"><div className="leader-intro"><Eyebrow icon={Trophy}>THE BOARD</Eyebrow><h2>Earn your<br /><span>place.</span></h2><p>Every point has a story. Climb through results earned in competition.</p><Link className="button button-ghost" to="/leaderboard">View leaderboard <ArrowRight size={15}/></Link></div><div className="leader-preview">{boards.loading ? <Loading/> : boards.error ? <ErrorState message={boards.error}/> : boards.data?.length ? boards.data.map((player,index)=><Link className={`leader-row ${index===0?'leader-first':''}`} key={player.id} to={`/players/${player.username}`}><span className="rank">{String(player.rank).padStart(2,'0')}</span><span className="leader-avatar">{player.username.slice(0,1).toUpperCase()}</span><span className="leader-person"><strong>{player.username} <ShieldBadge verified={player.verified}/></strong><small>LEVEL {player.level}</small></span><span className="leader-points"><strong><OGSymbol size={19}/>{Number(player.og_points).toLocaleString('en-IN')}</strong><small>OG POINTS</small></span><ArrowUpRight size={15}/></Link>) : <EmptyState title="The board is open" copy="Player rankings appear once results and points are recorded." icon={Trophy}/>}</div></section>
    <section className="join-band"><div className="shell join-band-inner"><div><Eyebrow>YOUR NAME GOES HERE</Eyebrow><h2>Ready when you are.</h2><p>Set up your player profile and get in the game.</p></div><Link className="button button-light" to="/register">Join Ocean Edge <ArrowRight size={16}/></Link></div><span className="join-orbit" aria-hidden="true" /></section>
  </>;
}

function HeroArt() { return <div className="hero-art" aria-label="Professional esports player competing in a live arena" role="img"><div className="art-arc art-arc-one"/><div className="art-arc art-arc-two"/><div className="art-orbit"/><div className="art-shard shard-one"/><div className="art-shard shard-two"/><div className="art-person"><span className="person-head"/><span className="person-body"/><span className="person-arm"/><span className="person-blade"/></div><div className="art-scanline"/><div className="art-label"><span>OEG // CIRCUIT 01</span><b>PLAYER<br/>UNKNOWN</b><small>READY TO DEPLOY</small></div><div className="art-stamp">EST.<br/><b>2026</b></div><div className="art-crosshair"><Crosshair size={17}/></div></div>; }


function TournamentCard({ tournament: t, index = 0 }) {
  const temporaryCount = useFakeRegistrationDisplayCount(t?.id);
  const displayedRegistrations = Number(t?.registration_count || 0) + temporaryCount;

  const statusLabels = {
    registration_open: 'Registration open',
    registration_not_open: 'Opens soon',
    registration_full: 'Registration full',
    registration_closed: 'Registration closed',
    started: 'Tournament started',
    ongoing: 'Live tournament',
    completed: 'Completed',
  };

  const statusTone =
    t.status === 'registration_open'
      ? 'open'
      : t.status === 'registration_not_open'
        ? 'soon'
        : t.status === 'registration_full'
          ? 'full'
          : t.status === 'registration_closed'
            ? 'closed'
            : ['started', 'ongoing'].includes(t.status)
              ? 'live'
              : 'ended';

  const isOpen = t.status === 'registration_open';
  const tournamentUrl = `/tournaments/${t.slug}`;

  return (
    <article className={`tournament-card tournament-card-new card-tone-${index % 3}`}>
      <Link
        to={tournamentUrl}
        className="t-card-image tournament-card-hero"
        aria-label={`View ${t.name}`}
      >
        {t.artwork_url ? (
          <img
            className="t-card-thumbnail"
            src={t.artwork_url}
            alt={`${t.name} tournament artwork`}
          />
        ) : (
          <div className="t-image-art tournament-card-art-fallback">
            <span className="t-art-ring" />
            <span className="t-art-slash" />
            <Gamepad2 size={58} />
          </div>
        )}

        <span className="tournament-card-shade" />

        <span className="tournament-card-index">
          {String(index + 1).padStart(2, '0')}
          <span> / FEATURED BRACKET</span>
        </span>

        <span className={`tournament-card-status status-${statusTone}`}>
          <span className="tournament-card-status-dot" />
          {statusLabels[t.status] || String(t.status || 'Status unavailable').replaceAll('_', ' ')}
        </span>

        <span className="tournament-card-game">
          <Gamepad2 size={14} />
          {t.game_name}
        </span>
      </Link>

      <div className="tournament-card-content">
        <div className="tournament-card-heading">
          <span className="tournament-card-kicker">
            {t.format_name || 'Tournament'}
          </span>

          <h3 className="tournament-card-name">
            <Link to={tournamentUrl}>{t.name}</Link>
          </h3>
        </div>

        <div className="tournament-card-info">
          <div className="tournament-card-info-item">
            <span className="tournament-card-info-icon date-icon">
              <CalendarDays size={19} />
            </span>
            <span className="tournament-card-info-copy">
              <small>TOURNAMENT DATE</small>
              <strong>{dateTime(t.start_at, { timeStyle: undefined })}</strong>
            </span>
          </div>

          <div className="tournament-card-info-item">
            <span className="tournament-card-info-icon mode-icon">
              <Crosshair size={19} />
            </span>
            <span className="tournament-card-info-copy">
              <small>GAME MODE</small>
              <strong>
                {Number(t.participant_count) > 1 ? 'Team' : 'Solo'}
                {t.format_name ? ` · ${t.format_name}` : ''}
              </strong>
            </span>
          </div>

          <div className="tournament-card-info-item">
            <span className="tournament-card-info-icon fee-icon">
              <Zap size={19} />
            </span>
            <span className="tournament-card-info-copy">
              <small>ENTRY FEE</small>
              <strong>{moneyOrFree(t.entry_fee_paise)}</strong>
            </span>
          </div>
        </div>

        <div className="tournament-card-bottom">
          <div className="tournament-card-registrations">
            <span className="tournament-card-people-icon">
              <Users size={19} />
            </span>
            <span>
              <strong>
                {displayedRegistrations.toLocaleString('en-IN')}
                {t.capacity ? ` / ${Number(t.capacity).toLocaleString('en-IN')}` : ''}
              </strong>
              <small>REGISTERED PLAYERS</small>
            </span>
          </div>

          <Link className="tournament-card-cta" to={tournamentUrl}>
            {isOpen ? 'View & register' : 'View tournament'}
            <ArrowRight size={17} />
          </Link>
        </div>
      </div>
    </article>
  );
}


function Tournaments() {
  const navigate=useNavigate();const location=useLocation();const params=new URLSearchParams(location.search);
  const [q,setQ]=useState(params.get('q')||'');const [game,setGame]=useState(params.get('game')||'');const [format,setFormat]=useState(params.get('format')||'');const [status,setStatus]=useState(params.get('status')||'');const [sort,setSort]=useState(params.get('sort')||'');const [page,setPage]=useState(1);
  const games=useData(()=>api('/games').then(v=>v.data),[]);
  const state=useData(()=>api(`/tournaments?limit=9&page=${page}&q=${encodeURIComponent(q)}&game=${encodeURIComponent(game)}&format=${encodeURIComponent(format)}&status=${encodeURIComponent(status)}&sort=${encodeURIComponent(sort)}`),[q,game,format,status,sort,page]);
  useEffect(()=>{if(params.has('game')&&params.get('game')!==game)setGame(params.get('game'));},[location.search]);
  return <div className="page-shell shell"><div className="page-heading"><div><Eyebrow icon={Compass}>THE OPEN BRACKET</Eyebrow><h1>Tournaments</h1><p>Find a bracket that fits your game and get in.</p></div><span className="page-marker">01 / COMPETE</span></div>
    <div className="filter-bar"><label className="search-field"><Search size={17}/><input value={q} onChange={e=>{setQ(e.target.value);setPage(1);}} placeholder="Search tournaments or games" /></label><select value={game} onChange={e=>{setGame(e.target.value);setPage(1);}}><option value="">All games</option>{(games.data||[]).map(g=><option key={g.id} value={g.slug}>{g.name}</option>)}</select><select value={format} onChange={e=>{setFormat(e.target.value);setPage(1);}}><option value="">All formats</option>{[...new Set((games.data||[]).flatMap(g=>g.formats.map(f=>f.name)))].map(name=><option key={name}>{name}</option>)}</select><select value={status} onChange={e=>{setStatus(e.target.value);setPage(1);}}><option value="">All statuses</option><option value="registration_open">Open</option><option value="registration_not_open">Not open yet</option><option value="registration_full">Registration full</option><option value="registration_closed">Registration closed</option><option value="started">Started</option><option value="ongoing">Ongoing</option><option value="completed">Completed</option></select><select value={sort} onChange={e=>{setSort(e.target.value);setPage(1);}}><option value="">Recommended</option><option value="start">Start date: soonest</option><option value="latest">Start date: latest</option><option value="fee_low">Entry fee: low to high</option><option value="fee_high">Entry fee: high to low</option><option value="name">Name: A to Z</option></select></div>
    {state.loading?<Loading/>:state.error?<ErrorState message={state.error}/>:state.data?.data?.length?<><div className="tournament-grid">{state.data.data.map((t,i)=><TournamentCard key={t.id} tournament={t} index={i}/>)}</div><Pagination page={page} limit={9} total={state.data.total} onChange={setPage}/></>:<EmptyState title="No tournaments match those filters" copy="Try another game or search term. Published brackets will appear as they open." icon={Swords}/>}
  </div>;
}

function Pagination({page,limit,total,onChange}){const pages=Math.ceil(total/limit);if(pages<2)return null;return <div className="pagination"><button className="button button-ghost button-small" disabled={page===1} onClick={()=>onChange(page-1)}>Previous</button><span>Page {page} of {pages}</span><button className="button button-ghost button-small" disabled={page===pages} onClick={()=>onChange(page+1)}>Next</button></div>;}

function TournamentDetail(){
  const {slug}=useParams();
  const state=useData(()=>api(`/tournaments/${slug}`).then(v=>v.tournament),[slug]);
  
const {user,toast}=useAuth();
const fakeRegistrationCount=useFakeRegistrationDisplayCount(state.data?.id);
const navigate=useNavigate();
const [teams,setTeams]=useState([]);
const [teamId,setTeamId]=useState('');
const [busy,setBusy]=useState(false);
const [manualCheckout,setManualCheckout]=useState(null);
const [activeDetailSection,setActiveDetailSection]=useState('prize-vault');

  useEffect(()=>{if(user?.role==='player')api('/teams').then(v=>setTeams(v.data)).catch(()=>{});},[user]);
  if(state.loading)return <div className="shell page-shell"><Loading/></div>;
  if(state.error)return <div className="shell page-shell"><ErrorState message={state.error}/></div>;
  const t = state.data;
const displayedRegistrations=Number(t.registration_count||0)+fakeRegistrationCount;
const needsTeam = Number(t.participant_count) > 1;

const fullDescription =
  t.description || 'Tournament details will be published by the organizer.';

const descriptionPreview = fullDescription
  .replace(/```[\s\S]*?```/g, ' ')
  .replace(/!\[.*?\]\(.*?\)/g, '')
  .replace(/\[([^\]]+)\]\(.*?\)/g, '$1')
  .replace(/^#{1,6}\s+/gm, '')
  .replace(/(\*\*|__|~~|\*|_|`)/g, '')
  .replace(/^\s*[-*+]\s+/gm, '')
  .replace(/^\s*\d+\.\s+/gm, '')
  .replace(/\s+/g, ' ')
  .trim();

const shortDescription =
  descriptionPreview.length > 230
    ? `${descriptionPreview.slice(0, 230).trimEnd()}...`
    : descriptionPreview;
    
  const register=async()=>{
    if(!user){navigate('/login',{state:{from:`/tournaments/${slug}`}});return;}
    setBusy(true);
    try{
      const created=await send(`/tournaments/${t.id}/register`,{...(needsTeam?{teamId}:{})});
      if(created.amountPaise>0){
        const checkout=await api(`/payments/checkout/${created.registration.id}`);
        if(checkout.paymentMethod==='manual'){setManualCheckout(checkout);return;}
        const order=await send('/payments/orders',{registrationId:created.registration.id});
        await loadRazorpay();
        const widget=new window.Razorpay({key:order.order.keyId,amount:order.order.amount,currency:order.order.currency,name:'Ocean Edge Games',description:order.order.tournamentName,order_id:order.order.id,theme:{color:'#f5233d'},handler:async(response)=>{try{await send('/payments/verify',response);toast('Payment verified. Registration #'+String(created.registration.registration_number).padStart(6,'0')+' is confirmed.');}catch(error){toast(error.message);}},modal:{ondismiss:()=>toast('Payment window closed. Your spot remains reserved until the timer expires.')}});
        widget.open();
      }else toast('Registration #'+String(created.registration.registration_number).padStart(6,'0')+' confirmed. You’re in.');
    }catch(error){toast(error.message);}finally{setBusy(false);}
  };
  
return (
  <>
    {manualCheckout && (
      <ManualCheckout
        checkout={manualCheckout}
        onClose={() => setManualCheckout(null)}
        toast={toast}
      />
    )}

    <div className="page-shell shell tournament-detail-page">
      <Link to="/tournaments" className="back-link">
        <ArrowRight size={14} /> All tournaments
      </Link>

      {/* HERO */}
      <section className="detail-hero">
        <div className="detail-art">
          {t.artwork_url ? (
            <img
              className="detail-thumbnail"
              src={t.artwork_url}
              alt={`${t.name} tournament artwork`}
            />
          ) : (
            <div className="detail-art-placeholder">
              <Gamepad2 size={44} />
              <span>{t.game_name}</span>
              <strong>{t.format_name}</strong>
            </div>
          )}

          <span className="detail-art-code">OEG // OPEN SERIES</span>
          <span className="detail-art-title">
            {t.game_name}
            <b>— {t.format_name}</b>
          </span>
        </div>

        <div className="detail-heading">
          <Eyebrow icon={Gamepad2}>
            {t.game_name} / {t.format_name}
          </Eyebrow>

          <StatusPill
            tone={
              t.canRegister
                ? 'live'
                : t.status === 'registration_full'
                  ? 'warning'
                  : 'muted'
            }
          >
            {t.canRegister
              ? 'Registration open'
              : t.status === 'registration_full'
                ? 'Registration full'
                : t.status === 'registration_not_open'
                  ? 'Registration opens soon'
                  : t.status === 'registration_closed'
                    ? 'Registration closed'
                    : t.status}
          </StatusPill>

          <h1>{t.name}</h1>

          <p className="detail-description-preview">
            {shortDescription}
          </p>


          <div className="detail-stats">
            <div>
              <span>ENTRY</span>
              <b>{moneyOrFree(t.entry_fee_paise)}</b>
            </div>
            <div>
              <span>STARTS</span>
              <b>{dateTime(t.start_at)}</b>
            </div>
            <div>
              <span>FORMAT</span>
              <b>{t.format_name} / {t.participant_count}</b>
            </div>
          </div>

          {t.canRegister && (
            <div className="register-controls">
              {needsTeam && (
                <select
                  value={teamId}
                  onChange={e => setTeamId(e.target.value)}
                >
                  <option value="">Choose your {t.format_name} team</option>
                  {teams
                    .filter(team => team.format_id === t.format_id)
                    .map(team => (
                      <option key={team.id} value={team.id}>
                        {team.name} · {team.roster.length}/{team.participant_count}
                      </option>
                    ))}
                </select>
              )}

              <button
                className="button"
                disabled={busy || (needsTeam && !teamId)}
                onClick={register}
              >
                {busy
                  ? 'Working…'
                  : Number(t.entry_fee_paise) > 0
                    ? 'Register & pay'
                    : 'Register now'}
                <ArrowRight size={16} />
              </button>
            </div>
          )}

          {Number(t.entry_fee_paise) > 0 && (
            <small className="refund-note">
              Read <Link to="/terms">Terms & Conditions</Link> before registering or paying fee.
            </small>
          )}
        </div>
      </section>

      {/* INFORMATION NAVIGATION */}
      
<nav className="detail-section-nav" aria-label="Tournament information">
  {[
    { id: 'prize-vault', label: 'Prize vault', Icon: Trophy },
    { id: 'event-briefing', label: 'Briefing', Icon: Globe2 },
    { id: 'event-rules', label: 'Rules', Icon: ShieldCheck },
  ].map(({ id, label, Icon }) => (
    <button
      key={id}
      type="button"
      className={`detail-tab ${activeDetailSection === id ? 'active' : ''}`}
      aria-expanded={activeDetailSection === id}
      aria-controls={id}
      onClick={() => setActiveDetailSection(id)}
    >
      <Icon size={16} />
      <span>{label}</span>
      <ChevronDown
        size={15}
        className="detail-tab-chevron"
      />
    </button>
  ))}
</nav>


      {/* MAIN CONTENT + SIDEBAR */}
      <div className="detail-columns detail-columns-redesigned">
        <div className="detail-main-content">

          {/* PRIZE VAULT */}
          {activeDetailSection === 'prize-vault' && (
  <section className="detail-content-panel prize-vault" id="prize-vault">
            <div className="detail-panel-heading">
              <div>
                <Eyebrow icon={Trophy}>THE REWARD BOARD</Eyebrow>
                <h2>Prize vault<span>.</span></h2>
              </div>
              <span className="detail-section-index">01</span>
            </div>

            {t.reward_config &&
            (
              Number(t.reward_config.cashPaise) > 0 ||
              Number(t.reward_config.ogPoints) > 0 ||
              Number(t.reward_config.xpPoints) > 0
            ) ? (
              <div className="prize-highlight-grid">
                {Number(t.reward_config.cashPaise) > 0 && (
                  <div className="prize-highlight prize-highlight-cash">
                    <span>CASH REWARDS</span>
                    <strong>{money(t.reward_config.cashPaise)}</strong>
                    <small>Cash prize pool</small>
                  </div>
                )}

                {Number(t.reward_config.ogPoints) > 0 && (
                  <div className="prize-highlight">
                    <span>OG POINTS</span>
                    <strong>
                      {Number(t.reward_config.ogPoints).toLocaleString('en-IN')}
                    </strong>
                    <small>Competition points</small>
                  </div>
                )}

                {Number(t.reward_config.xpPoints) > 0 && (
                  <div className="prize-highlight">
                    <span>XP REWARDS</span>
                    <strong>
                      {Number(t.reward_config.xpPoints).toLocaleString('en-IN')}
                    </strong>
                    <small>Experience points</small>
                  </div>
                )}
              </div>
            ) : null}

            {Array.isArray(t.reward_config?.rankRewards) &&
              t.reward_config.rankRewards.length > 0 && (
                <div className="detail-rank-list">
                  {t.reward_config.rankRewards
                    .slice()
                    .sort((a, b) => Number(a.place) - Number(b.place))
                    .map(reward => (
                      <div className="detail-rank-row" key={reward.place}>
                        <span className="detail-rank-medal">
                          {Number(reward.place) === 0
                            ? 'ALL'
                            : Number(reward.place) === 1
                            ? '01'
                            : String(reward.place).padStart(2, '0')}
                        </span>
                        <strong>
                          {Number(reward.place) === 0
                            ? 'Every contender'
                            : `${['1st', '2nd', '3rd'][Number(reward.place) - 1] || `${reward.place}th`} place`}
                        </strong>
                        <div>
                          {Number(reward.cashPaise) > 0 && (
                            <span>{money(reward.cashPaise)}</span>
                          )}
                          {Number(reward.ogPoints) > 0 && (
                            <span>
                              {Number(reward.ogPoints).toLocaleString('en-IN')} OG
                            </span>
                          )}
                          {Number(reward.xpPoints) > 0 && (
                            <span>
                              {Number(reward.xpPoints).toLocaleString('en-IN')} XP
                            </span>
                          )}
                        </div>
                      </div>
                    ))}
                </div>
              )}

            {Array.isArray(t.prizes) && t.prizes.length > 0 ? (
              <div className="detail-custom-prizes">
                {t.prizes.map((prize, index) => (
                  <article className="detail-custom-prize" key={index}>
                    <span>{String(index + 1).padStart(2, '0')}</span>
                    <div>
                      <strong>{prize.place}</strong>
                      <p>{prize.description}</p>
                    </div>
                  </article>
                ))}
              </div>
            ) : !t.reward_config &&
              (!Array.isArray(t.prizes) || !t.prizes.length) ? (
              <p className="muted-copy">
                Prize details will be announced by the organizer.
              </p>
            ) : null}
          </section>
          )}

          {/* FULL DESCRIPTION */}
          {activeDetailSection === 'event-briefing' && (
  <section className="detail-content-panel detail-full-description" id="event-briefing">
            <div className="detail-panel-heading">
              <div>
                <Eyebrow icon={Globe2}>THE EVENT BRIEFING</Eyebrow>
                <h2>Know your mission<span>.</span></h2>
              </div>
              <span className="detail-section-index">02</span>
            </div>

            <div className="detail-markdown">
              <ReactMarkdown>{fullDescription}</ReactMarkdown>
            </div>
          </section>
          )}

          {/* RULES */}
          {activeDetailSection === 'event-rules' && (
  <section className="detail-content-panel detail-rules-panel" id="event-rules">
            <div className="detail-panel-heading">
              <div>
                <Eyebrow icon={ShieldCheck}>FAIR PLAY PROTOCOL</Eyebrow>
                <h2>Rules of engagement<span>.</span></h2>
              </div>
              <span className="detail-section-index">03</span>
            </div>

            <div className="detail-markdown">
              {t.rules?.trim() ? (
                <ReactMarkdown>{t.rules}</ReactMarkdown>
              ) : (
                <p>
                  Rules have not been published yet. Check back for official
                  instructions from the organizer before registering.
                </p>
              )}
            </div>
          </section>
          )}
        </div>

        {/* SIDEBAR */}
        <aside className="detail-sidebar">
          <div className="side-panel detail-sticky-panel">
            <Eyebrow icon={CalendarDays}>KEY DATES</Eyebrow>

            <div className="timeline-row">
              <span className="timeline-dot" />
              <div>
                <small>REGISTRATION OPENS</small>
                <strong>{dateTime(t.registration_opens_at)}</strong>
              </div>
            </div>

            <div className="timeline-row">
              <span className="timeline-dot red" />
              <div>
                <small>REGISTRATION CLOSES</small>
                <strong>{dateTime(t.registration_deadline)}</strong>
              </div>
            </div>

            <div className="timeline-row">
              <span className="timeline-dot red" />
              <div>
                <small>TOURNAMENT STARTS</small>
                <strong>{dateTime(t.start_at)}</strong>
              </div>
            </div>

          </div>

          <div className="side-panel">
            <Eyebrow icon={Activity}>MATCH SCHEDULE</Eyebrow>

            {t.matches?.length ? (
              t.matches.map(match => (
                <div key={match.id} className="match-schedule">
                  <span className="status-dot" />
                  <div>
                    <strong>{match.title}</strong>
                    <small>{dateTime(match.scheduledAt)}</small>
                  </div>
                  <StatusPill tone={match.status === 'completed' ? 'success' : 'muted'}>
                    {match.status}
                  </StatusPill>
                </div>
              ))
            ) : (
              <p className="muted-copy">
                Match schedule will be published when ready.
              </p>
            )}
          </div>
        </aside>
      </div>
    </div>
  </>
);

}

function ManualCheckout({checkout,onClose,toast}){const [proof,setProof]=useState(null);const [busy,setBusy]=useState(false);const [error,setError]=useState('');const submit=async e=>{e.preventDefault();if(!proof)return;setBusy(true);setError('');try{const body=new FormData();body.append('registrationId',checkout.registrationId);body.append('proof',proof);await api('/payments/manual/submit',{method:'POST',body});toast(`REG-${String(checkout.registrationNumber).padStart(6,'0')} submitted for payment verification.`);onClose();}catch(err){setError(err.message);}finally{setBusy(false);}};return <div className="modal-backdrop" role="presentation" onMouseDown={e=>e.target===e.currentTarget&&onClose()}><section className="payment-checkout-modal" role="dialog" aria-modal="true" aria-labelledby="manual-payment-title"><button type="button" className="modal-close" onClick={onClose} aria-label="Close">×</button><span className="eyebrow">UPI / MANUAL PAYMENT</span><h2 id="manual-payment-title">Complete your entry.</h2><p>{checkout.tournamentName} · REG-{String(checkout.registrationNumber).padStart(6,'0')}</p><strong className="payment-amount">{money(checkout.amountPaise)}</strong>{checkout.qrUrl?<img className="payment-qr-preview" src={checkout.qrUrl} alt="Tournament payment QR code"/>:<div className="form-error">Payment QR is unavailable. Contact tournament support.</div>}<p>Scan the QR or pay <strong>{checkout.amountPaise>0?money(checkout.amountPaise):''}</strong> to <strong>{checkout.upiId}</strong>. Include REG-{String(checkout.registrationNumber).padStart(6,'0')} in the payment note, finish the transfer in your UPI app, then upload its success screen. Your entry remains pending until an administrator confirms receipt.</p><form className="form-stack" onSubmit={submit}><label>Payment screenshot<input required type="file" accept="image/png,image/jpeg,image/webp" onChange={e=>setProof(e.target.files?.[0]||null)}/><small>PNG, JPEG, or WebP · up to 4 MB</small></label>{proof&&<img className="payment-proof-preview" src={URL.createObjectURL(proof)} alt="Selected payment proof preview"/>}{error&&<div className="form-error">{error}</div>}<button className="button" disabled={busy||!proof}>{busy?'Submitting…':'Submit for verification'}</button></form></section></div>}

function PlayerPayments({toast=()=>{}}){const [refresh,setRefresh]=useState(0);const state=useData(()=>api('/payments/history').then(v=>v.data),[refresh]);const [busy,setBusy]=useState('');const [error,setError]=useState('');const [manualCheckout,setManualCheckout]=useState(null);const openManual=async row=>{setError('');try{setManualCheckout(await api(`/payments/checkout/${row.registration_id}`));}catch(e){setError(e.message);}};const retry=async row=>{setError('');try{setBusy(row.registration_id);const order=await send('/payments/orders',{registrationId:row.registration_id});await loadRazorpay();new window.Razorpay({key:order.order.keyId,amount:order.order.amount,currency:order.order.currency,name:'Ocean Edge Games',description:order.order.tournamentName,order_id:order.order.id,handler:async response=>{try{await send('/payments/verify',response);setRefresh(x=>x+1);}catch(e){setError(e.message);}},modal:{ondismiss:()=>setBusy('')}}).open();}catch(e){setError(e.message);setBusy('');}};if(state.loading)return <div className="shell player-space"><Loading/></div>;if(state.error)return <div className="shell player-space"><div className="form-error">{state.error}</div></div>;const label=row=>row.review_status==='rejected'?'Rejected':row.payment_attempt_status==='pending_verification'?'Pending Verification':['captured','verified'].includes(row.payment_attempt_status)?'Verified':row.payment_attempt_status==='failed'&&row.review_status==='rejected'?'Rejected':row.registration_payment_status==='paid'?'Verified':row.registration_payment_status==='pending_verification'?'Pending Verification':row.registration_payment_status==='rejected'?'Rejected':row.registration_payment_status==='pending'||row.registration_payment_status==='failed'?'Payment Required':row.registration_payment_status==='refunded'?'Refunded':'Not required';return <>{manualCheckout&&<ManualCheckout checkout={manualCheckout} onClose={()=>{setManualCheckout(null);setRefresh(x=>x+1);}} toast={toast}/>}<div className="shell player-space"><div className="welcome-row"><div><span className="eyebrow">ARENA HUB / PAYMENTS</span><h1>Payments & rewards.</h1><p>Review entry payments and see what your XP can unlock in the rewards store.</p></div></div>{error&&<div className="form-error">{error}</div>}<PaymentRewardsPanel/><section className="dash-section"><div className="dash-section-heading"><div><Eyebrow>TOURNAMENT ENTRIES</Eyebrow><h2>Payment history.</h2></div></div><div className="payment-history-list">{state.data?.length?state.data.map(row=><article className="payment-history-card" key={row.payment_id||row.registration_id}><div><span className="eyebrow">REG-{String(row.registration_number).padStart(6,'0')} · {row.payment_method==='manual'?'UPI':'RAZORPAY'}</span><h2>{row.tournament_name}</h2><p>{money(row.amount_paise)} · {dateTime(row.created_at||row.registration_created_at)}</p><span className={`status-pill status-${label(row)==='Verified'?'success':label(row)==='Rejected'?'danger':'warning'}`}>{label(row)}</span>{row.review_status==='rejected'&&<p className="form-error">{row.review_reason||'Payment proof was rejected. Submit a new screenshot after checking the payment details.'}</p>}</div>{row.review_status==='pending'&&row.proof_url&&<img className="payment-history-proof" src={row.proof_url} alt="Your submitted payment proof"/>}{!row.payment_id||['rejected','pending','failed'].includes(row.registration_payment_status)&&row.registration_status==='pending_payment'&&(row.payment_method==='manual'?<button className="button button-small" onClick={()=>openManual(row)}>Pay by UPI / resubmit</button>:<button className="button button-small" onClick={()=>retry(row)} disabled={!!busy}>{busy===row.registration_id?'Opening…':'Pay now'}</button>)}</article>):<div className="empty-state"><strong>No payments yet</strong><p>Your registrations and entry payment statuses will appear here.</p></div>}</div></section></div></>}

function PaymentRewardsPanel(){const state=useData(()=>api('/rewards'),[]);if(state.loading)return <div className="dash-section"><Loading/></div>;if(state.error)return <div className="dash-section"><ErrorState message={state.error}/></div>;const d=state.data;const xp=d.xpPoints.reduce((sum,item)=>sum+Number(item.points),0);const og=d.ogPoints.reduce((sum,item)=>sum+Number(item.points),0);const offers=[['Profile cosmetics','Frames, banners, and profile styles',250,'profile'],['Tournament entry','Use XP toward future event entries',500,'tournament'],['Gaming rewards','Digital rewards from the OEG store',1000,'gaming']];return <section className="dash-section payment-rewards-panel"><div className="dash-section-heading"><div><Eyebrow>XP REWARDS STORE</Eyebrow><h2>Rewards are on the way.</h2></div><span className="coming-soon-pill">COMING SOON</span></div><p>XP can be exchanged for rewards when the store launches. Your balance is tracked now; redemptions are not available yet.</p><div className="payment-reward-balances"><span><XPSymbol size={18}/> XP balance <strong>{xp.toLocaleString('en-IN')}</strong></span><span><OGSymbol size={18}/> OG Points <strong>{og.toLocaleString('en-IN')}</strong></span></div><div className="xp-reward-preview-grid">{offers.map(([title,copy,cost,key])=><article className="xp-reward-preview" key={key}><span className={`xp-reward-art xp-reward-art-${key}`}>{key==='profile'?<Image size={22}/>:key==='tournament'?<Trophy size={22}/>:<Gamepad2 size={22}/>}</span><strong>{title}</strong><small>{copy}</small><b><XPSymbol size={16}/>{cost.toLocaleString('en-IN')} XP</b><button type="button" disabled>Coming soon</button></article>)}</div></section>}

function loadRazorpay(){return new Promise((resolve,reject)=>{if(window.Razorpay)return resolve(true);const script=document.createElement('script');script.src='https://checkout.razorpay.com/v1/checkout.js';script.onload=()=>resolve(true);script.onerror=()=>reject(new Error('Payment checkout could not be loaded.'));document.body.appendChild(script);});}

function AuthFrame({eyebrow,title,copy,children,aside='PLAY WITH PURPOSE'}){return <div className="auth-page"><div className="auth-shell"><div className="auth-art"><Brand/><span className="auth-art-number">OEG / 001</span><div className="auth-art-shape"><span/><b>MAKE<br/>YOUR<br/><em>MOVE.</em></b></div><div className="auth-art-foot"><span>OCEAN EDGE GAMES</span><span>19°04' N · 72°52' E</span></div></div><div className="auth-panel"><Link className="back-link" to="/"><ArrowRight size={14}/> Back to home</Link><Eyebrow>{eyebrow}</Eyebrow><h1>{title}</h1><p>{copy}</p>{children}</div></div></div>;}

function Login({adminMode=false}){
  const {setUser}=useAuth();const navigate=useNavigate();const location=useLocation();const [form,setForm]=useState({email:adminMode?'admin@ocean.games':'',password:''});const [error,setError]=useState('');const [busy,setBusy]=useState(false);
  useEffect(()=>{if(adminMode)setForm(f=>({...f,email:'admin@ocean.games'}));},[adminMode]);
  const submit=async e=>{e.preventDefault();setError('');setBusy(true);try{const result=await send('/auth/login',form);if(adminMode&&result.user.role!=='admin')throw new Error('Administrator sign-in failed.');setUser(result.user);navigate(location.state?.from||(result.user.role==='admin'?'/pass/ads/dashboard':'/arena'),{replace:true});}catch(err){setError(err.message);}finally{setBusy(false);}};
  return <AuthFrame eyebrow={adminMode?'SECURE ADMIN ACCESS':'WELCOME BACK'} title={adminMode?'Admin sign in':'Back in the game.'} copy={adminMode?'Sign in to the Ocean Edge operations console.':'Pick up where your last match left off.'}><form className="form-stack" onSubmit={submit}><label>Email address<input type="email" value={form.email} readOnly={adminMode} required autoComplete="username" onChange={e=>setForm({...form,email:e.target.value})}/></label><label>Password<input type="password" value={form.password} required autoComplete="current-password" onChange={e=>setForm({...form,password:e.target.value})}/></label>{error&&<FormError>{error}</FormError>}<button className="button form-submit" disabled={busy}>{busy?'Signing in…':adminMode?'Enter admin console':'Sign in'} <ArrowRight size={16}/></button>{!adminMode&&<div className="form-inline"><Link to="/forgot-password">Forgot password?</Link><span>No account? <Link to="/register">Join free</Link></span></div>}</form></AuthFrame>;
}

function Register() {
  const navigate = useNavigate();

  const [form, setForm] = useState({
    email: '',
    password: '',
    confirmPassword: '',
  });

  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setError('');

    if (form.password !== form.confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    setBusy(true);

    try {
      const result = await send('/auth/register', form);

      sessionStorage.setItem(
        'oeg-verification-email',
        form.email
      );

      sessionStorage.setItem(
        'oeg-resend-after',
        result.resendAfter || ''
      );

      // Clear any verification flag left by a previous attempt.
      sessionStorage.removeItem('oeg-profile-verified');

      // Skip OTP only when the backend confirms that this
      // registration was already verified.
      if (result.profileSetupRequired === true) {
        sessionStorage.setItem('oeg-profile-verified', 'yes');
      }

      navigate('/verify-email');
    } catch (err) {
      setError(err.message || 'Registration failed. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthFrame
      eyebrow="CREATE YOUR PLAYER ID"
      title="Your next chapter starts here."
      copy="Set up your login, verify your email, and finish your player profile."
    >
      <form className="form-stack" onSubmit={submit}>
        <label>
          Email address
          <input
            type="email"
            required
            autoComplete="email"
            value={form.email}
            onChange={(e) =>
              setForm({ ...form, email: e.target.value })
            }
          />
        </label>

        <label>
          Password
          <input
            type="password"
            required
            minLength="10"
            autoComplete="new-password"
            value={form.password}
            onChange={(e) =>
              setForm({ ...form, password: e.target.value })
            }
          />
          <small>
            10+ characters, upper and lower case, and a number.
          </small>
        </label>

        <label>
          Confirm password
          <input
            type="password"
            required
            autoComplete="new-password"
            value={form.confirmPassword}
            onChange={(e) =>
              setForm({ ...form, confirmPassword: e.target.value })
            }
          />
        </label>

        {error && <FormError>{error}</FormError>}

        <button className="button form-submit" disabled={busy}>
          {busy ? 'Sending code…' : 'Continue to email verification'}
          <ArrowRight size={16} />
        </button>

        <div className="form-inline">
          Already registered? <Link to="/login">Sign in</Link>
        </div>
      </form>
    </AuthFrame>
  );
}

function VerifyEmail(){const email=sessionStorage.getItem('oeg-verification-email')||'';const [code,setCode]=useState('');const [profile,setProfile]=useState(()=>sessionStorage.getItem('oeg-profile-verified')==='yes');const [form,setForm]=useState({fullName:'',username:'',age:'',phone:'',upiId:''});const [error,setError]=useState('');const [busy,setBusy]=useState(false);const [resend,setResend]=useState(0);const {setUser}=useAuth();const navigate=useNavigate();
  useEffect(()=>{const then=new Date(sessionStorage.getItem('oeg-resend-after')||0).getTime();const tick=()=>setResend(Math.max(0,Math.ceil((then-Date.now())/1000)));tick();const timer=setInterval(tick,1000);return()=>clearInterval(timer);},[]);
  const verify=async e=>{e.preventDefault();setError('');setBusy(true);try{await send('/auth/verify-code',{email,code});sessionStorage.setItem('oeg-profile-verified','yes');setProfile(true);}catch(err){setError(err.message);}finally{setBusy(false);}};
  const finish=async e=>{e.preventDefault();setError('');setBusy(true);try{const result=await send('/auth/complete-profile',form);setUser(result.user);sessionStorage.removeItem('oeg-verification-email');sessionStorage.removeItem('oeg-profile-verified');navigate('/arena',{replace:true});}catch(err){setError(err.message);}finally{setBusy(false);}};
  const reSend=async()=>{setError('');try{const result=await send('/auth/resend-code',{email});sessionStorage.setItem('oeg-resend-after',result.resendAfter);setResend(60);}catch(err){setError(err.message);}};
  if(!email)return <AuthFrame eyebrow="EMAIL VERIFICATION" title="Let’s pick up your entry." copy="Start from registration to request a new verification code."><Link className="button" to="/register">Return to registration <ArrowRight size={16}/></Link></AuthFrame>;
  return <AuthFrame eyebrow={profile?'PLAYER PROFILE':'EMAIL VERIFICATION'} title={profile?'Make it yours.':'Check your inbox.'} copy={profile?'Add the details that make your player profile yours.':`Enter the six-digit code sent to ${email}.`}><form className="form-stack" onSubmit={profile?finish:verify}>{!profile?<><label>Verification code<input className="otp-input" inputMode="numeric" autoComplete="one-time-code" maxLength="6" pattern="[0-9]{6}" placeholder="000000" value={code} onChange={e=>setCode(e.target.value.replace(/\D/g,'').slice(0,6))} required/></label><button className="button form-submit" disabled={busy}>{busy?'Verifying…':'Verify email'} <ArrowRight size={16}/></button><div className="form-inline"><span>Code expires in 10 minutes.</span><button type="button" className="inline-button" disabled={resend>0} onClick={reSend}>{resend?`Resend in ${resend}s`:'Resend code'}</button></div></>:<><label>Full name<input required value={form.fullName} onChange={e=>setForm({...form,fullName:e.target.value})}/></label><label>Unique username<input required minLength="3" maxLength="24" pattern="[A-Za-z0-9_]+" value={form.username} onChange={e=>setForm({...form,username:e.target.value})}/><small>Letters, numbers, and underscores only.</small></label><div className="form-pair"><label>Age<input type="number" min="13" max="120" required value={form.age} onChange={e=>setForm({...form,age:e.target.value})}/></label><label>Phone number<input type="tel" placeholder="+919876543210" required value={form.phone} onChange={e=>setForm({...form,phone:e.target.value})}/></label></div><label>UPI ID <span className="optional">optional · private</span><input value={form.upiId} onChange={e=>setForm({...form,upiId:e.target.value})}/></label><button className="button form-submit" disabled={busy}>{busy?'Creating profile…':'Enter the Arena'} <ArrowRight size={16}/></button></>}{error&&<FormError>{error}</FormError>}</form></AuthFrame>;
}

function ForgotPassword(){const [email,setEmail]=useState('');const [sent,setSent]=useState(false);const [error,setError]=useState('');const [busy,setBusy]=useState(false);const submit=async e=>{e.preventDefault();setBusy(true);setError('');try{await send('/auth/forgot-password',{email});setSent(true);}catch(err){setError(err.message);}finally{setBusy(false);}};return <AuthFrame eyebrow="ACCOUNT RECOVERY" title="Let’s get you back in." copy="Enter your email and we’ll send a one-time reset link if there’s an eligible account.">{sent?<div className="success-panel"><ShieldCheck/><strong>Check your inbox</strong><p>If an eligible account exists, a password reset link has been sent.</p></div>:<form className="form-stack" onSubmit={submit}><label>Email address<input type="email" required value={email} onChange={e=>setEmail(e.target.value)}/></label>{error&&<FormError>{error}</FormError>}<button className="button form-submit" disabled={busy}>{busy?'Requesting…':'Send reset link'} <ArrowRight size={16}/></button></form>}<Link className="auth-bottom-link" to="/login">Back to sign in</Link></AuthFrame>;}

function ResetPassword(){const token=new URLSearchParams(window.location.search).get('token')||'';const [form,setForm]=useState({password:'',confirmPassword:''});const [error,setError]=useState('');const [done,setDone]=useState(false);const [busy,setBusy]=useState(false);const navigate=useNavigate();const submit=async e=>{e.preventDefault();setError('');if(form.password!==form.confirmPassword)return setError('Passwords do not match.');setBusy(true);try{await send('/auth/reset-password',{token,...form});setDone(true);}catch(err){setError(err.message);}finally{setBusy(false);}};return <AuthFrame eyebrow="NEW CREDENTIALS" title="Set a new password." copy="Choose a fresh password for your player account.">{done?<div className="success-panel"><ShieldCheck/><strong>Password updated</strong><p>Your account is ready. Sign in using your new password.</p><button className="button" onClick={()=>navigate('/login')}>Sign in <ArrowRight size={16}/></button></div>:<form className="form-stack" onSubmit={submit}><label>New password<input type="password" minLength="10" required value={form.password} onChange={e=>setForm({...form,password:e.target.value})}/></label><label>Confirm new password<input type="password" minLength="10" required value={form.confirmPassword} onChange={e=>setForm({...form,confirmPassword:e.target.value})}/></label>{error&&<FormError>{error}</FormError>}<button className="button form-submit" disabled={busy||!token}>{busy?'Updating…':'Update password'} <ArrowRight size={16}/></button></form>}</AuthFrame>;}

function FormError({children}){return <div className="form-error" role="alert">{children}</div>;}
function LegalPage({kind}){const terms=kind==='terms';return <div className="shell legal-page"><Eyebrow>OCEAN EDGE GAMES / {terms?'TERMS':'PRIVACY'}</Eyebrow><h1>{terms?'Terms & Conditions':'Privacy Policy'}</h1><p className="legal-lede">Last updated 28 October 2026</p>{terms?<><h2>Fair play and accounts</h2><p>Players must provide accurate account details, protect their credentials, and follow the rules published for each tournament. Account access may be suspended or blocked for platform abuse, fraud, or tournament rule violations.</p><h2>Tournament entries and fees</h2><p>Entry fees are displayed before registration and collected through the payment method enabled for that tournament checkout. Manual UPI entries remain pending until an administrator verifies receipt of funds; uploading a screenshot does not confirm payment. Tournament cancellation and refund eligibility are handled under the published event policy.</p><p><strong>Tournament entry-fee refunds are not available within the final 48 hours before the scheduled tournament start.</strong> The 48-hour deadline uses the event's configured start time and timezone. Earlier requests remain subject to the published cancellation policy and administrator review.</p><h2>Points and prizes</h2><p>OG Points are progression and leaderboard points. They are not cash and cannot be withdrawn. XP is separate and gift redemption is not currently available. Cash prizes are recorded separately and do not guarantee payout until their status is confirmed.</p><h2>Changes and support</h2><p>Event details may change. Material changes will be announced in the platform. Contact support from your player area for questions about accounts, events, or payments.</p></>:<><h2>Information we keep</h2><p>We store account email, password hashes, player profile details, tournament registrations, team membership, points, support messages, notifications, payment records, and submitted payment screenshots needed to operate the platform.</p><h2>Private information</h2><p>Passwords, verification codes, password reset tokens, UPI IDs, room credentials, payment secrets, and payment screenshots are not public profile data. Screenshots are stored privately and available to the submitting player and authorized administrators. Administrator views never display player passwords or password hashes.</p><h2>Use and access</h2><p>Profile and account data is used for authentication, tournament operations, support, fraud prevention, and the leaderboards you participate in. You can request help with account access through support.</p><h2>Payments and email</h2><p>When Razorpay is enabled, payment verification is performed by the provider and verified server-side. When manual UPI is enabled, uploaded proof is reviewed by an administrator. Ocean Edge Games does not store card credentials. Email verification and recovery messages are sent through the platform's configured email provider.</p><h2>Retention and security</h2><p>Financial and competition records may be retained to preserve event history and accounting accuracy. Access controls and server-side checks protect private account data.</p></>}</div>;}

function NotFound(){return <div className="shell page-shell not-found"><span className="eyebrow">404 / LOST IN THE ARENA</span><h1>That page isn't in the bracket.</h1><Link to="/" className="button">Back to the home page <ArrowRight size={16}/></Link></div>;}

function PlayerDashboard(){
  const {user}=useAuth();const state=useData(()=>api('/player/dashboard'),[]);if(state.loading)return <div className="shell player-space"><Loading/></div>;if(state.error)return <div className="shell player-space"><ErrorState message={state.error}/></div>;const d=state.data;const upcomingGames=d.matches.map(m=>({...m,kind:'match'})).sort((a,b)=>new Date(a.scheduled_at)-new Date(b.scheduled_at)).slice(0,4);
  return <div className="shell player-space"><div className="welcome-row"><div><Eyebrow icon={Crosshair}>ARENA HUB / YOUR SPACE</Eyebrow><h1>Welcome back, {d.profile.full_name.split(' ')[0]}.</h1><p>Here’s what’s moving in your arena.</p></div><Link className="button button-ghost" to="/profile">Edit profile <ArrowUpRight size={15}/></Link></div>
    <div className="player-stat-grid"><div className="player-stat-card player-stat-main"><span><OGSymbol size={18}/> OG POINTS</span><strong>{Number(d.profile.og_points).toLocaleString('en-IN')}</strong><div className="stat-progress"><i style={{width:`${Math.round(d.profile.progress*100)}%`}}/></div><small>LEVEL {d.profile.level} · {d.profile.pointsToNextLevel.toLocaleString('en-IN')} to next level</small></div><div className="player-stat-card"><span>PLAYER LEVEL</span><strong className="stat-level">{String(d.profile.level).padStart(2,'0')}<small>/ 100</small></strong><small>Current progression</small></div><div className="player-stat-card"><span><XPSymbol size={18}/> XP POINTS</span><strong>{Number(d.profile.xp_points).toLocaleString('en-IN')}</strong><small>Gift redemption · coming soon</small></div><Link to="/notifications" className="player-stat-card stat-link"><span>NOTIFICATIONS</span><strong>{d.unreadCount}<Bell size={19}/></strong><small>Unread updates <ArrowUpRight size={13}/></small></Link></div>
    <div className="dashboard-columns"><section className="dash-section"><div className="dash-section-heading"><div><Eyebrow icon={CalendarDays}>WHAT'S NEXT</Eyebrow><h2>Your upcoming matches.</h2></div><Link className="text-link" to="/matches">All matches <ArrowRight size={14}/></Link></div>{upcomingGames.length?upcomingGames.map(m=><div className="dash-list-row" key={m.id}><div className="dash-date"><span>{new Date(m.scheduled_at).toLocaleDateString('en-IN',{day:'2-digit'})}</span><small>{new Date(m.scheduled_at).toLocaleDateString('en-IN',{month:'short'})}</small></div><div className="dash-list-copy"><strong>{m.title}</strong><small>{m.tournament_name} · {dateTime(m.scheduled_at)}</small></div><StatusPill tone={m.status==='ongoing'?'live':'muted'}>{m.status}</StatusPill></div>):<EmptyState title="No matches scheduled" copy="Tournament registrations appear under Your Entries until the organizer schedules a match." icon={CalendarDays}/>}</section>
      <section className="dash-section"><div className="dash-section-heading"><div><Eyebrow icon={Swords}>YOUR ENTRIES</Eyebrow><h2>On the board.</h2></div><Link className="text-link" to="/tournaments">Find a game <ArrowRight size={14}/></Link></div>{d.upcomingTournaments.length?d.upcomingTournaments.map(t=><Link to={t.payment_status==='pending_verification'?'/payments':`/tournaments/${t.slug}`} className="entry-row" key={t.id}><span className="entry-mark"><Gamepad2 size={18}/></span><span className="dash-list-copy"><strong>{t.tournament_name}</strong><small>{t.game_name} · {t.format_name} · {dateTime(t.start_at)} · REG-{String(t.registration_number).padStart(6,'0')}</small></span><StatusPill tone={t.payment_status==='paid'?'success':t.payment_status==='rejected'?'danger':'warning'}>{t.payment_status==='pending_verification'?'Pending verification':t.payment_status==='pending'||t.payment_status==='failed'?'Payment required':t.payment_status==='paid'?t.status:t.status}</StatusPill></Link>):<EmptyState title="No active entries yet" copy="Explore tournaments and find a bracket that fits." icon={Trophy}/>}</section></div>
    <section className="dash-section upcoming-section"><div className="dash-section-heading"><div><Eyebrow icon={Zap}>UPCOMING IN OEG</Eyebrow><h2>Keep it on your radar.</h2></div></div>{d.upcoming.length?<div className="upcoming-grid">{d.upcoming.map(item=><a className={`upcoming-card ${item.pinned?'is-pinned':''}`} href={item.href||'#'} key={item.id} onClick={e=>{if(!item.href)e.preventDefault();}}><span className="upcoming-type">{item.pinned?'PINNED':'UP NEXT'}</span><strong>{item.title}</strong><p>{item.description}</p><ArrowUpRight size={17}/></a>)}</div>:<EmptyState title="No upcoming announcements" copy="The OEG team will share the next important update here." icon={Zap}/>}</section>
    <section className="dash-section announce-section"><div className="dash-section-heading"><div><Eyebrow icon={Globe2}>FROM THE ORGANIZERS</Eyebrow><h2>Latest announcements.</h2></div></div>{d.announcements.length?d.announcements.map(a=><div className="announcement-row" key={a.id}><div><strong>{a.title}</strong><p>{a.body}</p></div><small>{a.published_at?dateTime(a.published_at):'OEG update'}</small></div>):<EmptyState title="No announcements yet" copy="Organizer updates will appear here." icon={Bell}/>}</section>
  </div>;
}

function ProfileAssetPicker({title,kind,assets=[],selected,onSelect,currentUrl}){
  return <section className={`profile-asset-picker profile-asset-picker-${kind}`} aria-label={title}><div className="profile-picker-heading"><div><strong>{title}</strong><small>Choose from artwork approved by the OEG team.</small></div><span>{assets.length} available</span></div><div className="profile-picker-grid">
    <button type="button" className={`profile-asset-choice profile-asset-default ${selected?'':'selected'}`} aria-pressed={!selected} onClick={()=>onSelect('')}><span className="profile-asset-image profile-asset-placeholder">{currentUrl?<img src={currentUrl} alt="Current profile artwork"/>:<Image size={22}/>}</span><span className="profile-asset-copy"><strong>Default</strong><small>Ocean Edge style</small></span>{!selected&&<BadgeCheck className="profile-asset-check" size={17}/>}</button>
    {assets.map(asset=><button type="button" key={asset.id} className={`profile-asset-choice ${selected===asset.id?'selected':''}`} aria-pressed={selected===asset.id} onClick={()=>onSelect(asset.id)}><span className="profile-asset-image">{asset.url?<img src={asset.url} alt={asset.label}/>:<Image size={20}/>}</span><span className="profile-asset-copy"><strong>{asset.label}</strong><small>OEG approved · Level {asset.min_level}+</small></span>{selected===asset.id&&<BadgeCheck className="profile-asset-check" size={17}/>}</button>)}
    {!assets.length&&<p className="profile-assets-empty">No approved options yet. The default artwork will be used.</p>}
  </div></section>;
}
function Profile(){
  const {user,setUser,toast}=useAuth();const [revision,setRevision]=useState(0);const [editing,setEditing]=useState(false);
  const state=useData(()=>api(`/players/${user.username}`).then(v=>v.player),[user.username,revision]);
  if(state.loading)return <div className="shell page-shell"><Loading/></div>;if(state.error)return <div className="shell page-shell"><ErrorState message={state.error}/></div>;
  return <><PublicProfileView p={state.data} action={<button className="button" onClick={()=>setEditing(true)}>Edit Profile <ArrowUpRight size={15}/></button>}/>{editing&&<ProfileEditor onClose={()=>setEditing(false)} onSaved={username=>{if(username)setUser(current=>({...current,username}));setEditing(false);setRevision(x=>x+1);toast('Profile saved.');}}/>}</>;
}
function ProfileEditor({onClose,onSaved}){
  const [form,setForm]=useState(null);const [loading,setLoading]=useState(true);const [error,setError]=useState('');const [busy,setBusy]=useState(false);const [activeType,setActiveType]=useState('');const [assetCache,setAssetCache]=useState({});const [assetLoading,setAssetLoading]=useState(false);const [games,setGames]=useState([]);const [gameAccounts,setGameAccounts]=useState([]);
  useEffect(()=>{let alive=true;Promise.all([api('/profile'),api('/games')]).then(([v,g])=>{if(alive&&v.profile){setForm({...v.profile,avatarAssetId:v.profile.avatar_asset_id||'',bannerAssetId:v.profile.banner_asset_id||'',backgroundAssetId:v.profile.background_asset_id||''});setGameAccounts(v.profile.gameAccounts||[]);}if(alive)setGames(g.data||[]);}).catch(e=>alive&&setError(e.message)).finally(()=>alive&&setLoading(false));return()=>{alive=false;};},[]);
  const editArt=async type=>{setActiveType(type);if(assetCache[type])return;setAssetLoading(true);setError('');try{const value=await api(`/profile/assets?type=${type}`);setAssetCache(current=>({...current,[type]:value[type+'s']||[]}));}catch(e){setError(e.message);}finally{setAssetLoading(false);}};
  if(loading)return <div className="profile-editor-backdrop" role="presentation"><section className="profile-editor"><Loading/></section></div>;
  if(!form)return <div className="profile-editor-backdrop" role="presentation"><section className="profile-editor"><FormError>{error||'Could not load profile settings.'}</FormError><button className="button button-ghost" onClick={onClose}>Close</button></section></div>;
  const fields={avatar:'avatarAssetId',banner:'bannerAssetId',background:'backgroundAssetId'};const urlFields={avatar:'avatar_url',banner:'banner_url',background:'background_url'};const titleFields={avatar:'Player picture',banner:'Profile banner',background:'Profile background'};
  const save=async event=>{event.preventDefault();setError('');const accounts=gameAccounts.map(account=>({gameId:account.game_id,identifier:String(account.game_identifier||'').trim()}));if(accounts.some(account=>!account.gameId||account.identifier.length<2)){setError('Choose a game and enter its username or UID, or remove the unfinished row.');return;}if(new Set(accounts.map(account=>account.gameId)).size!==accounts.length){setError('Add each game only once.');return;}setBusy(true);try{const saved=await send('/profile',{fullName:form.full_name,username:form.username,phone:form.phone,upiId:form.upi_id||'',bio:form.bio||'',avatarAssetId:form.avatarAssetId||null,bannerAssetId:form.bannerAssetId||null,backgroundAssetId:form.backgroundAssetId||null,gameAccounts:accounts},'PUT');onSaved(saved.username);}catch(e){setError(e.message);}finally{setBusy(false);}};
  const addGameAccount=()=>setGameAccounts(rows=>[...rows,{game_id:'',game_name:'',game_identifier:'',draftKey:`new-${Date.now()}-${Math.random()}`}]);
  const updateGameAccount=(index,key,value)=>setGameAccounts(rows=>rows.map((row,i)=>i===index?{...row,[key]:value,...(key==='game_id'?{game_name:games.find(game=>game.id===value)?.name||''}:{})}:row));
  const removeGameAccount=index=>setGameAccounts(rows=>rows.filter((_,i)=>i!==index));
  return <div className="profile-editor-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)onClose();}}><section className="profile-editor" role="dialog" aria-modal="true" aria-labelledby="profile-editor-title"><div className="profile-editor-head"><div><Eyebrow>PLAYER SETTINGS</Eyebrow><h2 id="profile-editor-title">Edit Profile</h2></div><button type="button" className="icon-button" aria-label="Close profile editor" onClick={onClose}><X size={19}/></button></div><form className="profile-editor-form" onSubmit={save}><div className="form-pair"><label>Full name<input required minLength="2" maxLength="80" value={form.full_name||''} onChange={e=>setForm({...form,full_name:e.target.value})}/></label><label>Username<input required minLength="3" maxLength="24" pattern="[A-Za-z0-9_]+" value={form.username||''} onChange={e=>setForm({...form,username:e.target.value})}/><small>At most 2 changes in any 10 days.</small></label></div><label>About you<textarea rows="3" maxLength="280" value={form.bio||''} onChange={e=>setForm({...form,bio:e.target.value})}/></label><div className="form-pair"><label>Phone number<input required value={form.phone||''} onChange={e=>setForm({...form,phone:e.target.value})}/></label><label>UPI ID <span className="optional">private</span><input value={form.upi_id||''} onChange={e=>setForm({...form,upi_id:e.target.value})}/></label></div>
    <section className="profile-game-settings"><div className="profile-game-settings-heading"><div><Eyebrow>GAME IDENTITIES</Eyebrow><p>Add the username or UID you use in each game. These details are saved with your profile and shown on your public player page.</p></div><span className="profile-game-count">{gameAccounts.length} added</span></div>{gameAccounts.length?<div className="profile-game-account-list">{gameAccounts.map((account,index)=><div className="profile-game-account-row profile-game-account-edit-row" key={account.draftKey||account.game_id||index}><label>Game<select required value={account.game_id||''} onChange={e=>updateGameAccount(index,'game_id',e.target.value)}><option value="">Choose a game</option>{games.map(game=><option key={game.id} value={game.id} disabled={gameAccounts.some((other,otherIndex)=>otherIndex!==index&&other.game_id===game.id)}>{game.name}</option>)}</select></label><label>In-game username / UID<input required minLength="2" maxLength="80" value={account.game_identifier||''} onChange={e=>updateGameAccount(index,'game_identifier',e.target.value)} placeholder="Enter your game ID"/></label><button type="button" className="inline-button danger" onClick={()=>removeGameAccount(index)}>Remove</button></div>)}</div>:<p className="profile-game-empty">No game IDs added. Add one or more games below.</p>}<button type="button" className="button button-ghost button-small profile-add-game" onClick={addGameAccount}><Gamepad2 size={14}/> Add more game</button></section>
    <div className="profile-editor-art"><Eyebrow>PROFILE ART</Eyebrow><div className="profile-art-actions">{['avatar','banner','background'].map(type=><button key={type} type="button" className="button button-ghost button-small" onClick={()=>editArt(type)}>{activeType===type?'Editing':'Edit '+titleFields[type].toLowerCase()} <Image size={14}/></button>)}</div>{activeType&&<div className="profile-lazy-assets">{assetLoading?<Loading/>:error?<FormError>{error}</FormError>:<ProfileAssetPicker title={titleFields[activeType]} kind={activeType} assets={assetCache[activeType]||[]} selected={form[fields[activeType]]} currentUrl={form[urlFields[activeType]]} onSelect={id=>setForm({...form,[fields[activeType]]:id})}/>}</div>}</div>
    {error&&<FormError>{error}</FormError>}<div className="profile-editor-foot"><button type="button" className="button button-ghost" onClick={onClose}>Cancel</button><button className="button" disabled={busy}>{busy?'Saving…':'Save changes'} <ArrowRight size={15}/></button></div></form></section></div>;
}
function PasswordChange(){const [form,setForm]=useState({currentPassword:'',password:'',confirmPassword:''});const [error,setError]=useState('');const [busy,setBusy]=useState(false);const [reload,setReload]=useState(0);const {toast}=useAuth();const sessions=useData(()=>api('/sessions'),[reload]);const submit=async e=>{e.preventDefault();setError('');if(form.password!==form.confirmPassword)return setError('Passwords do not match.');setBusy(true);try{await send('/auth/change-password',form);setForm({currentPassword:'',password:'',confirmPassword:''});setReload(x=>x+1);toast('Password changed. Other sessions were signed out.');}catch(e){setError(e.message);}finally{setBusy(false);}};const revoke=async()=>{try{const result=await send('/sessions/others',{},'DELETE');setReload(x=>x+1);toast(`${result.revoked} other session${result.revoked===1?'':'s'} signed out.`);}catch(e){toast(e.message);}};return <div className="shell player-space"><div className="welcome-row"><div><Eyebrow icon={ShieldCheck}>PLAYER PROFILE / SECURITY</Eyebrow><h1>Account security.</h1><p>Change your password and manage active sign-ins.</p></div></div><div className="security-panel"><section className="settings-form"><form onSubmit={submit}><Eyebrow>CHANGE PASSWORD</Eyebrow><label>Current password<input type="password" autoComplete="current-password" required value={form.currentPassword} onChange={e=>setForm({...form,currentPassword:e.target.value})}/></label><div className="form-pair"><label>New password<input type="password" autoComplete="new-password" minLength="10" required value={form.password} onChange={e=>setForm({...form,password:e.target.value})}/><small>10+ characters, upper and lower case, and a number.</small></label><label>Confirm new password<input type="password" autoComplete="new-password" minLength="10" required value={form.confirmPassword} onChange={e=>setForm({...form,confirmPassword:e.target.value})}/></label></div>{error&&<FormError>{error}</FormError>}<button className="button" disabled={busy}>{busy?'Updating…':'Update password'} <ArrowRight size={15}/></button></form></section><section className="settings-form session-controls"><div className="widget-head"><div><Eyebrow>ACTIVE SESSIONS</Eyebrow><h2>Your sign-ins.</h2></div><button className="button button-ghost button-small" onClick={revoke} disabled={sessions.loading||!sessions.data?.data?.some(s=>!s.current)}>Sign out other sessions</button></div>{sessions.loading?<Loading/>:sessions.error?<ErrorState message={sessions.error}/>:sessions.data.data.length?sessions.data.data.map((s,i)=><div className="session-row" key={`${s.current}-${s.expire}-${i}`}><span><strong>{s.current?'This session':'Other session'}</strong><small>Expires {dateTime(s.expire)}</small></span><StatusPill tone={s.current?'success':'muted'}>{s.current?'Current':'Active'}</StatusPill></div>):<p className="muted-copy">No active sessions were found.</p>}</section></div></div>;}

function Notifications(){const {toast}=useAuth();const [refresh,setRefresh]=useState(0);const state=useData(()=>api('/notifications'),[refresh]);const markAll=async()=>{try{await send('/notifications/read-all',{},'PATCH');setRefresh(x=>x+1);toast('All notifications marked as read.');}catch(e){toast(e.message);}};const mark=async id=>{await send(`/notifications/${id}/read`,{},'PATCH');setRefresh(x=>x+1);};return <div className="shell player-space"><div className="welcome-row"><div><Eyebrow icon={Bell}>ARENA HUB / INBOX</Eyebrow><h1>Notifications.</h1><p>Your tournament, team, and account updates.</p></div><button className="button button-ghost" onClick={markAll}>Mark all as read</button></div>{state.loading?<Loading/>:state.error?<ErrorState message={state.error}/>:state.data.data.length?<div className="notice-list">{state.data.data.map(n=><div className={`notice-row ${!n.read_at?'is-unread':''}`} key={n.id}><span className="notice-icon"><Bell size={16}/></span><div><strong>{n.title}</strong><p>{n.body}</p><small>{dateTime(n.created_at)}</small></div><div className="notice-actions">{n.href&&<Link className="text-link" to={n.href}>Open <ArrowRight size={13}/></Link>}{!n.read_at&&<button className="inline-button" onClick={()=>mark(n.id)}>Mark read</button>}</div></div>)}</div>:<EmptyState title="All caught up" copy="New updates will land here." icon={Bell}/>}</div>;}

function Teams(){
  const {toast,user}=useAuth();const games=useData(()=>api('/games').then(v=>v.data),[]);const profile=useData(()=>api('/profile').then(v=>v.profile),[]);const [refresh,setRefresh]=useState(0);const teams=useData(()=>api('/teams').then(v=>v.data),[refresh]);const invites=useData(()=>api('/teams/invitations').then(v=>v.data),[refresh]);const [create,setCreate]=useState({gameId:'',formatId:'',name:'',logo:null});const [invite,setInvite]=useState({teamId:'',username:''});const [manual,setManual]=useState({});const [addModes,setAddModes]=useState({});const [busy,setBusy]=useState(false);const [logoPreview,setLogoPreview]=useState('');
  useEffect(()=>{if(!create.logo){setLogoPreview('');return;}const url=URL.createObjectURL(create.logo);setLogoPreview(url);return()=>URL.revokeObjectURL(url);},[create.logo]);
  const selectedGame=games.data?.find(g=>g.id===create.gameId);const formats=(selectedGame?.formats||[]).filter(f=>Number(f.participantCount)>1);const selectedFormat=formats.find(f=>f.id===create.formatId);const hasGameAccount=(profile.data?.gameAccounts||[]).some(account=>account.game_id===create.gameId);
  const createTeam=async e=>{e.preventDefault();setBusy(true);try{const created=await send('/teams',{gameId:create.gameId,formatId:create.formatId,name:create.name});if(create.logo&&!isSolo){const body=new FormData();body.append('logo',create.logo);await api(`/teams/${created.team.id}/logo`,{method:'POST',body});}toast('Team created. You are the leader.');setCreate({gameId:'',formatId:'',name:'',logo:null});setRefresh(x=>x+1);}catch(e){toast(e.message);}finally{setBusy(false);}};
  const invitePlayer=async e=>{e.preventDefault();try{await send(`/teams/${invite.teamId}/invitations`,{username:invite.username});toast('Invitation sent.');setInvite({...invite,username:''});}catch(e){toast(e.message);}};
  const addManual=async(e,team)=>{e.preventDefault();const form=manual[team.id]||{name:'',usernameOrUid:''};try{await send(`/teams/${team.id}/manual-members`,form);toast('Player added to the roster.');setManual({...manual,[team.id]:{name:'',usernameOrUid:''}});setRefresh(x=>x+1);}catch(error){toast(error.message);}};
  const removeManual=async(teamId,guestId,name)=>{if(!window.confirm(`Remove ${name} from this roster?`))return;try{await send(`/teams/${teamId}/manual-members/${guestId}`,{},'DELETE');toast('Manual roster member removed.');setRefresh(x=>x+1);}catch(error){toast(error.message);}};
  const removeMember=async(team,member)=>{if(!window.confirm(`Remove @${member.username||member.name} from ${team.name}?`))return;try{await send(`/teams/${team.id}/members/${member.userId}`,{},'DELETE');toast('Team member removed.');setRefresh(x=>x+1);}catch(error){toast(error.message);}};
  const leaveTeam=async team=>{if(!window.confirm(`Leave ${team.name}? If you are captain, leadership will transfer to the longest-serving teammate. If you are the last registered member, the team will be deactivated. Past tournament records are kept.`))return;try{await send(`/teams/${team.id}/membership`,{},'DELETE');toast('You left the team.');setRefresh(x=>x+1);}catch(error){toast(error.message);}};
  const deleteTeam=async team=>{if(!window.confirm(`Delete ${team.name}? The team will be deactivated and hidden from active rosters. Historical registrations and results will be preserved.`))return;try{await send(`/teams/${team.id}`,{},'DELETE');toast('Team deleted.');setRefresh(x=>x+1);}catch(error){toast(error.message);}};
  const uploadLogo=async(team,file)=>{if(!file)return;const body=new FormData();body.append('logo',file);try{await api(`/teams/${team.id}/logo`,{method:'POST',body});toast('Team logo updated.');setRefresh(x=>x+1);}catch(error){toast(error.message);}};
  const answer=async(id,action)=>{try{await send(`/teams/invitations/${id}`,{action},'PATCH');setRefresh(x=>x+1);toast(action==='accept'?'Invitation accepted.':'Invitation declined.');}catch(e){toast(e.message);}};
  return <div className="shell player-space team-page"><div className="welcome-row"><div><Eyebrow icon={Users}>ARENA HUB / SQUADS</Eyebrow><h1>Your teams.</h1><p>Build a roster, invite players, and customize your team identity.</p></div></div><div className="dashboard-columns team-columns"><section className="dash-section"><div className="dash-section-heading"><div><Eyebrow>ACTIVE ROSTERS</Eyebrow><h2>My teams.</h2></div></div>{teams.loading?<Loading/>:teams.error?<ErrorState message={teams.error}/>:teams.data.length?teams.data.map(t=>{const solo=Number(t.participant_count)===1;const mode=addModes[t.id]||'invite';const memberForm=manual[t.id]||{name:'',usernameOrUid:''};return <div className="team-card" key={t.id}><div className="team-card-top"><span className={`team-logo-preview ${solo?'team-logo-solo':''}`}>{solo?(t.leader_avatar_url?<img src={t.leader_avatar_url} alt="Team leader profile"/>:<Users size={20}/>):t.logo_url?<img src={t.logo_url} alt={t.name+' logo'}/>:<ShieldCheck size={20}/>}</span><div><strong>{t.name}</strong><small>{t.game_name} · {t.format_name}</small></div><StatusPill tone="success">{t.roster.length}/{t.participant_count}</StatusPill></div><div className="team-roster">{t.roster.map(m=><span className="roster-chip" key={m.userId||m.guestId}>{m.username||m.name}{m.gameIdentifier&&<small> · {m.gameIdentifier}</small>}{m.role==='leader'&&<b> CAPTAIN</b>}{m.role==='guest'&&<b> MANUAL</b>}{t.leader_user_id===user?.id&&m.role==='guest'&&<button type="button" aria-label={'Remove '+m.name} onClick={()=>removeManual(t.id,m.guestId,m.name)}>×</button>}{t.leader_user_id===user?.id&&m.userId&&m.role!=='leader'&&<button type="button" aria-label={'Remove '+(m.username||m.name)} onClick={()=>removeMember(t,m)}>×</button>}</span>)}</div><div className="team-card-actions"><button type="button" className="inline-button" onClick={()=>leaveTeam(t)}>Leave team</button>{t.leader_user_id===user?.id&&<button type="button" className="inline-button danger" onClick={()=>deleteTeam(t)}>Delete team</button>}</div>{!solo&&t.leader_user_id===user?.id&&<label className="team-logo-upload">{t.logo_url?'Change team logo':'Upload team logo'}<Image size={14}/><input type="file" accept="image/png,image/jpeg,image/webp" onChange={e=>uploadLogo(t,e.target.files?.[0])}/></label>}{!solo&&<div className="team-member-tools"><div className="segmented"><button type="button" className={mode==='invite'?'active':''} onClick={()=>setAddModes({...addModes,[t.id]:'invite'})}>Invite Player</button><button type="button" className={mode==='manual'?'active':''} onClick={()=>setAddModes({...addModes,[t.id]:'manual'})}>Add Manually</button></div>{mode==='invite'?<form className="team-invite-form" onSubmit={invitePlayer}><input type="hidden" value={invite.teamId} readOnly/><input required value={invite.teamId===t.id?invite.username:''} onFocus={()=>setInvite({...invite,teamId:t.id})} onChange={e=>setInvite({teamId:t.id,username:e.target.value})} placeholder="Player username"/><button className="button button-small" disabled={t.leader_user_id!==user?.id}>Send invite <ArrowRight size={13}/></button></form>:<form className="team-manual-form" onSubmit={e=>addManual(e,t)}><label>Player name<input required minLength="2" maxLength="80" value={memberForm.name} onChange={e=>setManual({...manual,[t.id]:{...memberForm,name:e.target.value}})}/></label><label>Username / UID<input required minLength="2" maxLength="48" value={memberForm.usernameOrUid} onChange={e=>setManual({...manual,[t.id]:{...memberForm,usernameOrUid:e.target.value}})}/></label><button className="button button-small" disabled={t.leader_user_id!==user?.id}>Add to roster <ArrowRight size={13}/></button></form>}</div>}</div>}):<EmptyState title="No team yet" copy="Create a team for a supported game below." icon={Users}/>}</section><aside className="dash-section create-team-panel"><div className="dash-section-heading"><div><Eyebrow>START A ROSTER</Eyebrow><h2>Create a team.</h2></div></div><form className="form-stack" onSubmit={createTeam}><label>Game<select required value={create.gameId} onChange={e=>setCreate({...create,gameId:e.target.value,formatId:''})}><option value="">Choose a game</option>{(games.data||[]).map(g=><option key={g.id} value={g.id}>{g.name}</option>)}</select></label><label>Team format<select required value={create.formatId} onChange={e=>setCreate({...create,formatId:e.target.value})}><option value="">Choose a format</option>{formats.map(f=><option key={f.id} value={f.id}>{f.name} · {f.participantCount} player{f.participantCount>1?'s':''}</option>)}</select></label><label>Team name<input required minLength="2" maxLength="48" value={create.name} onChange={e=>setCreate({...create,name:e.target.value})}/></label>{selectedFormat&&Number(selectedFormat.participantCount)>1&&<label className="team-logo-file">Team logo (optional)<input type="file" accept="image/png,image/jpeg,image/webp" onChange={e=>setCreate({...create,logo:e.target.files?.[0]||null})}/>{logoPreview&&<img src={logoPreview} alt="Selected team logo preview"/>}</label>}{create.gameId&&!hasGameAccount&&<p className="team-account-required">Add this game username or UID to your <Link to="/profile">profile</Link> before creating the team.</p>}<button className="button" disabled={busy||!create.gameId||!hasGameAccount}>{busy?'Creating…':'Create team'} <ArrowRight size={15}/></button></form></aside></div><section className="dash-section invitation-section"><div className="dash-section-heading"><div><Eyebrow>INCOMING</Eyebrow><h2>Team invitations.</h2></div></div>{invites.loading?<Loading/>:invites.data?.length?invites.data.map(i=><div className="invite-row" key={i.id}><div><strong>{i.team_name}</strong><small>{i.game_name} · invited by @{i.invited_by}</small></div><button className="button button-small" onClick={()=>answer(i.id,'accept')}>Accept</button><button className="button button-ghost button-small" onClick={()=>answer(i.id,'decline')}>Decline</button></div>):<EmptyState title="No invitations waiting" copy="Invitations from captains appear here." icon={Users}/>}</section></div>;
}
function Matches(){const [filter,setFilter]=useState('upcoming');const state=useData(()=>api(`/matches?filter=${filter}`),[filter]);return <div className="shell player-space"><div className="welcome-row"><div><Eyebrow icon={CalendarDays}>ARENA HUB / MATCHES</Eyebrow><h1>Your match log.</h1><p>Schedules, room details, and results from matches scheduled by tournament admins.</p></div></div><div className="segmented">{['upcoming','ongoing','past'].map(f=><button className={filter===f?'active':''} onClick={()=>setFilter(f)} key={f}>{f}</button>)}</div>{state.loading?<Loading/>:state.error?<ErrorState message={state.error}/>:state.data.data.length?<div className="match-list">{state.data.data.map(m=><div className="match-card" key={m.id}><div className="match-date-block"><CalendarDays size={17}/><span>{dateTime(m.scheduled_at)}</span></div><div className="match-card-main"><small>{m.tournament_name}</small><strong>{m.title}</strong>{m.placement!==null&&m.placement!==undefined&&<span className="placement-label">{m.placement===0?'CONTENDER REWARD':`PLACED #${m.placement}`}</span>}</div><StatusPill tone={m.status==='ongoing'?'live':m.status==='completed'?'success':'muted'}>{m.status}</StatusPill>{m.room_id&&<div className="room-details"><span>ROOM <b>{m.room_id}</b></span>{m.room_password&&<span>PASS <b>{m.room_password}</b></span>}</div>}</div>)}</div>:<EmptyState title="No matches in this view" copy="Only scheduled match fixtures appear here. Tournament entries remain listed under Your Entries." icon={Swords}/>}</div>;}

function Rewards(){const state=useData(()=>api('/rewards'),[]);if(state.loading)return <div className="shell player-space"><Loading/></div>;if(state.error)return <div className="shell player-space"><ErrorState message={state.error}/></div>;const d=state.data;const og=d.ogPoints.reduce((sum,x)=>sum+Number(x.points),0);const xp=d.xpPoints.reduce((sum,x)=>sum+Number(x.points),0);const paid=Number(d.cash.paid||0);const pending=Number(d.cash.pending||0);return <div className="shell player-space"><div className="welcome-row"><div><Eyebrow icon={Trophy}>ARENA HUB / EARNED</Eyebrow><h1>Your rewards.</h1><p>Competition points and cash records, each in their own lane.</p></div></div><div className="reward-summary"><div><span><OGSymbol size={19}/> OG POINTS</span><strong>{og.toLocaleString('en-IN')}</strong><small>Leaderboard & level progression</small></div><div><span><XPSymbol size={19}/> XP POINTS</span><strong>{xp.toLocaleString('en-IN')}</strong><small>Gift redemption · Coming Soon</small></div><div><span>CASH PAID</span><strong>{money(paid)}</strong><small>Recorded as paid</small></div><div><span>CASH PENDING</span><strong>{money(pending)}</strong><small>Not yet paid</small></div></div><div className="dashboard-columns"><Ledger title="OG points ledger" items={d.ogPoints} suffix="pts"/><Ledger title="XP history" items={d.xpPoints} suffix="XP"/></div><section className="dash-section"><div className="dash-section-heading"><div><Eyebrow>CASH REWARDS / INR</Eyebrow><h2>Payout history.</h2></div></div>{d.cash.history.length?d.cash.history.map((item,i)=><div className="payout-row" key={i}><div><strong>{item.tournament_name||'Competition reward'}</strong><small>{dateTime(item.created_at)}</small></div><strong>{money(item.amount_paise)}</strong><StatusPill tone={item.status==='paid'?'success':item.status==='pending'?'warning':'muted'}>{item.status}</StatusPill></div>):<EmptyState title="No cash rewards recorded" copy="Cash rewards are recorded after finalized results. Entry fees are tracked separately." icon={Trophy}/>}</section></div>;}
function Ledger({title,items,suffix}){const Mark=suffix==='XP'?XPSymbol:OGSymbol;return <section className="dash-section"><div className="dash-section-heading"><div><Eyebrow>POINTS HISTORY</Eyebrow><h2>{title}.</h2></div></div>{items.length?items.map((item,i)=><div className="ledger-row" key={i}><div><strong>{item.reason}</strong><small>{dateTime(item.created_at)}</small></div><b className={Number(item.points)<0?'negative':'positive'}><Mark size={17}/>{Number(item.points)>0?'+':''}{item.points} {suffix}</b></div>):<EmptyState title="No points recorded yet" copy="Points earned from finalized results will appear here." icon={Zap}/>}</section>; }

createRoot(document.getElementById('root')).render(<App />);
