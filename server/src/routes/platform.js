import { Router } from 'express';
import { z } from 'zod';
import { query, withTransaction } from '../config/db.js';
import { requireAdmin, requireAuth, requirePlayer } from '../middleware/auth.js';
import { progressionForPoints } from '../domain/progression.js';
import { isTournamentVisible, statusForTournament } from '../domain/tournaments.js';
import { recordAudit, notifyAdmin } from '../services/audit.js';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { signedAssetUrl, uploadProfileAsset, removeProfileAsset } from '../services/storage.js';

export const platformRouter = Router();
const uuid = z.string().uuid();
const parse = (schema, body) => {
  const parsed = schema.safeParse(body);
  return parsed.success ? parsed.data : null;
};
const pageParams = (req) => ({ page: Math.max(1, Number.parseInt(req.query.page, 10) || 1), limit: Math.min(50, Math.max(1, Number.parseInt(req.query.limit, 10) || 20)) });
const userId = (req) => req.session.user.id;
const uploadImage=multer({storage:multer.memoryStorage(),limits:{fileSize:4*1024*1024,files:1}});
const safeHref=(value)=>!value||(/^\/(?!\/)/.test(value))||/^https:\/\//i.test(value);
function imageType(buffer){
  if(buffer.length>=8&&buffer.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return {mime:'image/png',ext:'png'};
  if(buffer.length>=3&&buffer[0]===0xff&&buffer[1]===0xd8&&buffer[2]===0xff)return {mime:'image/jpeg',ext:'jpg'};
  if(buffer.length>=12&&buffer.toString('ascii',0,4)==='RIFF'&&buffer.toString('ascii',8,12)==='WEBP')return {mime:'image/webp',ext:'webp'};
  return null;
}
platformRouter.get('/games', async (req, res) => {
  const result = await query(`select g.id,g.name,g.slug,g.description,g.artwork_url,
    coalesce(json_agg(json_build_object('id',f.id,'name',f.name,'participantCount',f.participant_count) order by f.participant_count) filter(where f.id is not null), '[]') formats
    from games g left join game_formats f on f.game_id=g.id and f.active=true where g.active=true group by g.id order by g.name`);
  res.json({ data: result.rows });
});

platformRouter.get('/profile/assets', requirePlayer, async (req,res)=>{
  const requested=String(req.query.type||'');const type=['avatar','banner','background'].includes(requested)?requested:'';
  const [result,points]=await Promise.all([
    query(`select apa.id,apa.asset_type,apa.label,apa.min_level,ua.storage_path from approved_profile_assets apa join uploaded_assets ua on ua.id=apa.asset_id where apa.approved=true and ua.approved=true and ($1='' or apa.asset_type=$1) order by apa.asset_type,apa.min_level,apa.label`,[type]),
    query('select coalesce(sum(points),0)::int points from og_points_ledger where user_id=$1',[userId(req)]),
  ]);
  const level=progressionForPoints(points.rows[0]?.points||0).level;
  const eligible=result.rows.filter(asset=>Number(asset.min_level)<=level);
  const assets=await Promise.all(eligible.map(async asset=>({...asset, url:await signedAssetUrl(asset.storage_path)})));
  res.json({avatars:assets.filter(x=>x.asset_type==='avatar'),banners:assets.filter(x=>x.asset_type==='banner'),backgrounds:assets.filter(x=>x.asset_type==='background')});
});

platformRouter.get('/profile/games',requirePlayer,async(req,res)=>{
  const result=await query(`select a.game_id,g.name game_name,g.slug,a.game_identifier,a.updated_at
    from player_game_accounts a join games g on g.id=a.game_id where a.user_id=$1 and g.active=true order by g.name`,[userId(req)]);
  res.json({data:result.rows});
});
platformRouter.put('/profile/games/:gameId',requirePlayer,async(req,res)=>{
  if(!uuid.safeParse(req.params.gameId).success)return res.status(400).json({error:'Choose a valid game.'});
  const data=parse(z.object({identifier:z.string().trim().min(2).max(80).regex(/^[a-zA-Z0-9_.# -]+$/)}),req.body);
  if(!data)return res.status(400).json({error:'Enter a valid game username or UID.'});
  try{
    const saved=await withTransaction(async(client)=>{
      const game=await client.query('select id from games where id=$1 and active=true',[req.params.gameId]);
      if(!game.rowCount)return {error:'That game is not currently available.'};
      const row=await client.query(`insert into player_game_accounts(user_id,game_id,game_identifier)
        values($1,$2,$3) on conflict(user_id,game_id) do update set game_identifier=excluded.game_identifier,updated_at=now()
        returning game_id,game_identifier`,[userId(req),req.params.gameId,data.identifier]);
      await recordAudit(client,userId(req),'player_game_account_updated','player_game_account',req.params.gameId);
      return row.rows[0];
    });
    if(saved.error)return res.status(400).json({error:saved.error});
    res.json({account:saved});
  }catch(error){if(error.code==='23505')return res.status(409).json({error:'That game username or UID is already linked to another player.'});throw error;}
});
platformRouter.delete('/profile/games/:gameId',requirePlayer,async(req,res)=>{
  if(!uuid.safeParse(req.params.gameId).success)return res.status(400).json({error:'Choose a valid game.'});
  await withTransaction(async(client)=>{await client.query('delete from player_game_accounts where user_id=$1 and game_id=$2',[userId(req),req.params.gameId]);await recordAudit(client,userId(req),'player_game_account_removed','player_game_account',req.params.gameId);});
  res.json({ok:true});
});

platformRouter.get('/results', async(req,res)=>{
  const result=await query(`select m.id match_id,m.title match_title,m.scheduled_at,t.name tournament_name,t.slug tournament_slug,g.name game_name,
    coalesce(p.username,team.name,'Entry') participant, mr.placement
    from match_results mr join matches m on m.id=mr.match_id join tournaments t on t.id=m.tournament_id join games g on g.id=t.game_id
    join tournament_registrations r on r.id=mr.registration_id left join player_profiles p on p.user_id=r.player_id left join teams team on team.id=r.team_id
    where m.status='completed' and not exists(select 1 from match_results newer where newer.correction_of=mr.id) order by mr.finalized_at desc nulls last limit 6`);
  res.json({data:result.rows});
});

platformRouter.get('/tournaments', async (req, res) => {
  const { page, limit } = pageParams(req);
  const search = String(req.query.q || '').trim().slice(0, 80);
  const game = String(req.query.game || '').trim().slice(0, 60);
  const format = String(req.query.format || '').trim().slice(0, 40);
  const status = ['registration_open','registration_not_open','registration_full','registration_closed','started','ongoing','completed'].includes(req.query.status) ? req.query.status : '';
  const sort = ({start:'t.start_at asc',latest:'t.start_at desc',fee_low:'t.entry_fee_paise asc,t.start_at asc',fee_high:'t.entry_fee_paise desc,t.start_at asc',name:'lower(t.name) asc'})[req.query.sort] || "case when t.status='published' and t.registration_opens_at<=now() and t.registration_deadline>now() then 0 else 1 end,t.start_at asc";
  const rows = await query(`select t.id,t.name,t.slug,t.description,t.artwork_url,t.artwork_path,t.status,t.start_at,t.registration_opens_at,t.registration_deadline,t.visibility_deadline,t.timezone,t.capacity,t.entry_fee_paise,
      g.name game_name,g.slug game_slug,f.name format_name,f.participant_count,
      (select count(*) from tournament_registrations r where r.tournament_id=t.id and (r.status='confirmed' or (r.status='pending_payment' and (r.payment_status='pending_verification' or r.reserved_until>now())))) registration_count,
      count(*) over() total_count
    from tournaments t join games g on g.id=t.game_id join game_formats f on f.id=t.format_id
    where t.status in ('published','registration_closed','ongoing','completed')
      and (t.visibility_mode='show' or (t.visibility_mode='auto' and (t.visibility_deadline is null or t.visibility_deadline>now())))
      and ($1='' or t.name ilike '%'||$1||'%' or g.name ilike '%'||$1||'%') and ($2='' or g.slug=$2) and ($3='' or f.name=$3)
      and ($4='' or (case when t.status='published' and t.capacity is not null and (select count(*) from tournament_registrations r where r.tournament_id=t.id and (r.status='confirmed' or (r.status='pending_payment' and (r.payment_status='pending_verification' or r.reserved_until>now()))))>=t.capacity then 'registration_full' when t.status='published' and t.registration_opens_at>now() then 'registration_not_open' when t.status='published' and t.start_at<=now() then 'started' when t.status='published' and t.registration_deadline<=now() then 'registration_closed' when t.status='published' then 'registration_open' else t.status end)=$4)
    order by ${sort}
    limit $5 offset $6`, [search, game, format, status, limit, (page - 1) * limit]);
  const data=await Promise.all(rows.rows.map(async row=>({...row,artwork_url:row.artwork_path?await signedAssetUrl(row.artwork_path):row.artwork_url,status:statusForTournament(row)})));
  res.json({ data, page, limit, total: Number(rows.rows[0]?.total_count || 0) });
});

platformRouter.get('/tournaments/:slug', async (req, res) => {
  const result = await query(`select t.*,g.name game_name,g.slug game_slug,f.name format_name,f.participant_count,
      (select count(*) from tournament_registrations r where r.tournament_id=t.id and (r.status='confirmed' or (r.status='pending_payment' and (r.payment_status='pending_verification' or r.reserved_until>now())))) registration_count,
      (select coalesce(json_agg(json_build_object('title',a.title,'body',a.body,'publishedAt',a.published_at) order by a.published_at desc),'[]') from site_announcements a where a.active=true) announcements,
      (select coalesce(json_agg(json_build_object('id',m.id,'title',m.title,'status',m.status,'scheduledAt',m.scheduled_at) order by m.scheduled_at),'[]') from matches m where m.tournament_id=t.id) matches
    from tournaments t join games g on g.id=t.game_id join game_formats f on f.id=t.format_id
    where t.slug=$1 and t.status in ('published','registration_closed','ongoing','completed')
      and (t.visibility_mode='show' or (t.visibility_mode='auto' and (t.visibility_deadline is null or t.visibility_deadline>now())))`, [req.params.slug]);
  if (!result.rowCount) return res.status(404).json({ error: 'Tournament not found.' });
  const row = result.rows[0];
  const artworkUrl=row.artwork_path?await signedAssetUrl(row.artwork_path):row.artwork_url;
  const now=new Date();
  res.json({ tournament: { ...row, artwork_url:artworkUrl,status: statusForTournament(row,now), canRegister: row.status === 'published' && isTournamentVisible(row,now) && (!row.registration_opens_at||new Date(row.registration_opens_at)<=now) && new Date(row.registration_deadline) > now && new Date(row.start_at)>now && (!row.capacity || Number(row.registration_count) < row.capacity) } });
});

platformRouter.get('/leaderboard', async (req, res) => {
  const { page, limit } = pageParams(req);
  const type = req.query.type === 'teams' ? 'teams' : 'players';
  const gameSlug = String(req.query.game || '').trim().slice(0, 60);
  const offset = (page - 1) * limit;
  if (type === 'teams') {
    const result = await query(`select t.id,t.name,g.name game_name,coalesce(sum(l.points),0)::int og_points,count(*) over() total_count,
      count(distinct tm.user_id)::int roster_size,
      (select count(distinct mr.match_id) from match_results mr join reward_transactions rt on rt.result_id=mr.id where rt.team_id=t.id and not exists(select 1 from match_results newer where newer.correction_of=mr.id))::int matches_played,
      (select count(distinct mr.match_id) from match_results mr join reward_transactions rt on rt.result_id=mr.id where rt.team_id=t.id and mr.placement=1 and not exists(select 1 from match_results newer where newer.correction_of=mr.id))::int wins
      from teams t join games g on g.id=t.game_id left join og_points_ledger l on l.team_id=t.id left join team_members tm on tm.team_id=t.id
      where t.active=true and ($1='' or g.slug=$1) group by t.id,g.name having coalesce(sum(l.points),0)>0 order by og_points desc,t.name asc limit $2 offset $3`, [gameSlug, limit, offset]);
    return res.json({ type, data: result.rows.map((row, index) => ({ ...row, rank: offset + index + 1 })), page, limit, total: Number(result.rows[0]?.total_count || 0) });
  }
    const result = await query(`select u.id,p.username,p.full_name,p.avatar_asset_id,coalesce(a.public_url,'') avatar_url,coalesce(a.min_level,1) avatar_min_level,bool_or(u.manual_verified_at is not null) verified,case when $1='' then 'All games' else max(g.name) end game_name,
      coalesce(sum(l.points),0)::int og_points,count(*) over() total_count,
      (select count(distinct mr.match_id) from match_results mr join tournament_registrations tr on tr.id=mr.registration_id where (tr.player_id=u.id or exists(select 1 from registration_participants rp where rp.registration_id=tr.id and rp.user_id=u.id)) and not exists(select 1 from match_results newer where newer.correction_of=mr.id))::int matches_played,
      (select count(distinct mr.match_id) from match_results mr join tournament_registrations tr on tr.id=mr.registration_id where (tr.player_id=u.id or exists(select 1 from registration_participants rp where rp.registration_id=tr.id and rp.user_id=u.id)) and mr.placement=1 and not exists(select 1 from match_results newer where newer.correction_of=mr.id))::int wins
    from users u join player_profiles p on p.user_id=u.id left join approved_profile_assets a on a.id=p.avatar_asset_id and a.approved=true
    left join og_points_ledger l on l.user_id=u.id left join match_results mr on mr.id=l.result_id left join matches m on m.id=mr.match_id left join tournaments t on t.id=m.tournament_id left join games g on g.id=t.game_id
    where u.status='active' and u.role='player' and ($1='' or g.slug=$1)
    group by u.id,p.username,p.full_name,p.avatar_asset_id,a.public_url,a.min_level having coalesce(sum(l.points),0)>0 order by og_points desc,p.username asc limit $2 offset $3`, [gameSlug, limit, offset]);
  const data = result.rows.map((row, index) => {const progression=progressionForPoints(row.og_points);const {avatar_min_level,...clean}=row;return {...clean,avatar_url:progression.level>=Number(avatar_min_level)?row.avatar_url:'',rank:offset+index+1,...progression};});
  res.json({ type, data, page, limit, total: Number(result.rows[0]?.total_count || 0) });
});

platformRouter.get('/players/search', async (req, res) => {
  const q = String(req.query.q || '').trim().replace(/^@/, '').slice(0, 40);
  if (q.length < 2) return res.json({ data: [] });
  const result = await query(`select u.id,p.username,p.full_name,p.avatar_asset_id,coalesce(a.public_url,'') avatar_url,coalesce(a.min_level,1) avatar_min_level,ua.storage_path avatar_path,u.manual_verified_at is not null verified,
    coalesce((select sum(points) from og_points_ledger l where l.user_id=u.id),0)::int og_points,
    coalesce((select sum(points) from xp_points_ledger xp where xp.user_id=u.id),0)::int xp_points,
    (select count(*) from follows f where f.followed_id=u.id)::int followers
    from users u join player_profiles p on p.user_id=u.id left join approved_profile_assets a on a.id=p.avatar_asset_id and a.approved=true left join uploaded_assets ua on ua.id=a.asset_id and ua.approved=true
    where u.role='player' and u.status='active' and p.username ilike '%'||$1||'%' order by p.username limit 20`, [q]);
  const data=await Promise.all(result.rows.map(async(row)=>{const avatarPath=row.avatar_path;const level=progressionForPoints(row.og_points).level;delete row.avatar_path;const {avatar_min_level,...clean}=row;return {...clean,avatar_url:level>=Number(avatar_min_level)?(avatarPath?await signedAssetUrl(avatarPath):row.avatar_url):'',...progressionForPoints(row.og_points)}}));
  res.json({ data });
});

platformRouter.get('/players/:username', async (req, res) => {
  const result = await query(`select u.id,p.username,p.full_name,p.bio,p.avatar_asset_id,p.background_asset_id,p.banner_asset_id,
    coalesce(avatar.min_level,1) avatar_min_level,coalesce(bg.min_level,1) background_min_level,coalesce(banner.min_level,1) banner_min_level,
    coalesce(avatar.public_url,'') avatar_url,coalesce(bg.public_url,'') background_url,coalesce(banner.public_url,'') banner_url,u.email_verified_at,u.manual_verified_at,
    coalesce((select sum(points) from og_points_ledger l where l.user_id=u.id),0)::int og_points,
    coalesce((select sum(points) from xp_points_ledger xp where xp.user_id=u.id),0)::int xp_points,
    (select count(*) from follows f where f.followed_id=u.id)::int followers,
    (select count(*) from follows f where f.follower_id=u.id)::int following,avatar_path.storage_path avatar_path,bg_path.storage_path background_path,banner_path.storage_path banner_path
    from users u join player_profiles p on p.user_id=u.id
    left join approved_profile_assets avatar on avatar.id=p.avatar_asset_id and avatar.approved=true
    left join approved_profile_assets bg on bg.id=p.background_asset_id and bg.approved=true
    left join approved_profile_assets banner on banner.id=p.banner_asset_id and banner.approved=true
    left join uploaded_assets avatar_path on avatar_path.id=avatar.asset_id and avatar_path.approved=true
    left join uploaded_assets bg_path on bg_path.id=bg.asset_id and bg_path.approved=true
    left join uploaded_assets banner_path on banner_path.id=banner.asset_id and banner_path.approved=true
    where u.role='player' and u.status='active' and lower(p.username)=lower($1)`, [req.params.username]);
  if (!result.rowCount) return res.status(404).json({ error: 'Player not found.' });
  const player = result.rows[0];
  const playerLevel=progressionForPoints(player.og_points).level;
  const [avatar,background,banner,achievementMetrics,gameStats,recentMatches,tournaments,gameAccounts]=await Promise.all([
    playerLevel>=Number(player.avatar_min_level)?(player.avatar_path?signedAssetUrl(player.avatar_path):player.avatar_url):'',
    playerLevel>=Number(player.background_min_level)?(player.background_path?signedAssetUrl(player.background_path):player.background_url):'',
    playerLevel>=Number(player.banner_min_level)?(player.banner_path?signedAssetUrl(player.banner_path):player.banner_url):'',
    query(`select count(distinct m.id)::int matches_played,
      count(distinct m.id) filter(where final_result.placement=1)::int wins,
      count(distinct m.id) filter(where final_result.placement between 1 and 3)::int podiums,
      case when count(distinct m.id)=0 then null else round(count(distinct m.id) filter(where final_result.placement=1)*100.0/count(distinct m.id))::int end win_rate
      from tournament_registrations r
      left join match_participants mp on mp.registration_id=r.id
      left join matches m on m.id=mp.match_id and m.status='completed'
      left join lateral (select mr.placement from match_results mr where mr.match_id=m.id and mr.registration_id=r.id
        and not exists(select 1 from match_results newer where newer.correction_of=mr.id)
        order by mr.finalized_at desc nulls last,mr.created_at desc limit 1) final_result on true
      where r.status='confirmed' and (r.player_id=$1 or exists(select 1 from registration_participants rp where rp.registration_id=r.id and rp.user_id=$1))`,[player.id]),
    query(`select g.id,g.name,count(distinct r.id)::int tournaments,count(distinct m.id)::int matches
      from tournament_registrations r join tournaments t on t.id=r.tournament_id join games g on g.id=t.game_id
      left join match_participants mp on mp.registration_id=r.id left join matches m on m.id=mp.match_id and m.status='completed'
      where r.status='confirmed' and (r.player_id=$1 or exists(select 1 from registration_participants rp where rp.registration_id=r.id and rp.user_id=$1))
      group by g.id order by tournaments desc,matches desc,g.name limit 6`,[player.id]),
    query(`select m.id,m.scheduled_at,t.name tournament_name,g.name game_name,
      (select mr.placement from match_results mr where mr.match_id=m.id and mr.registration_id=r.id
        and not exists(select 1 from match_results newer where newer.correction_of=mr.id)
        order by mr.finalized_at desc nulls last,mr.created_at desc limit 1) placement
      from tournament_registrations r join match_participants mp on mp.registration_id=r.id
      join matches m on m.id=mp.match_id and m.status='completed' join tournaments t on t.id=m.tournament_id join games g on g.id=t.game_id
      where r.status='confirmed' and (r.player_id=$1 or exists(select 1 from registration_participants rp where rp.registration_id=r.id and rp.user_id=$1))
      order by m.scheduled_at desc limit 8`,[player.id]),
    query(`select recent.name,recent.slug,recent.start_at,recent.game_name from (
      select distinct on (t.id) t.id,t.name,t.slug,t.start_at,g.name game_name,r.created_at
      from tournament_registrations r join tournaments t on t.id=r.tournament_id join games g on g.id=t.game_id
      where r.status='confirmed' and (r.player_id=$1 or exists(select 1 from registration_participants rp where rp.registration_id=r.id and rp.user_id=$1))
      order by t.id,r.created_at desc) recent order by recent.created_at desc limit 8`,[player.id]),
    query(`select g.id game_id,g.name game_name,g.slug,a.game_identifier from player_game_accounts a join games g on g.id=a.game_id where a.user_id=$1 and g.active=true order by g.name`,[player.id]),
  ]);
  delete player.avatar_path;delete player.background_path;delete player.banner_path;delete player.avatar_min_level;delete player.background_min_level;delete player.banner_min_level;
  const profileMetrics=achievementMetrics.rows[0]||{matches_played:0,wins:0,podiums:0,win_rate:null};
  res.json({ player: { ...player, avatar_url:avatar,background_url:background,banner_url:banner||background,gameAccounts:gameAccounts.rows,gameStats:gameStats.rows,recentMatches:recentMatches.rows,tournaments:tournaments.rows,achievementMetrics:{matchesPlayed:Number(profileMetrics.matches_played||0),wins:Number(profileMetrics.wins||0),podiums:Number(profileMetrics.podiums||0),winRate:profileMetrics.win_rate==null?null:Number(profileMetrics.win_rate)},...progressionForPoints(player.og_points), verified: Boolean(player.manual_verified_at), emailVerified: Boolean(player.email_verified_at), manualVerified: Boolean(player.manual_verified_at) } });
});

platformRouter.get('/player/dashboard', requirePlayer, async (req, res) => {
  const id = userId(req);
  const [profile, registrations, matches, upcomingRegistrations, notices, unread, announcements, upcoming] = await Promise.all([
    query(`select p.full_name,p.username,p.avatar_asset_id,coalesce(a.public_url,'') avatar_url,coalesce(a.min_level,1) avatar_min_level,ua.storage_path avatar_path,coalesce((select sum(points) from og_points_ledger l where l.user_id=p.user_id),0)::int og_points,coalesce((select sum(points) from xp_points_ledger x where x.user_id=p.user_id),0)::int xp_points from player_profiles p left join approved_profile_assets a on a.id=p.avatar_asset_id and a.approved=true left join uploaded_assets ua on ua.id=a.asset_id and ua.approved=true where p.user_id=$1`, [id]),
    query(`select r.id,r.registration_number,r.reference,r.status,r.payment_status,t.name tournament_name,t.slug,t.start_at,g.name game_name,f.name format_name from tournament_registrations r join tournaments t on t.id=r.tournament_id join games g on g.id=t.game_id join game_formats f on f.id=t.format_id where (r.player_id=$1 or exists(select 1 from registration_participants rp where rp.registration_id=r.id and rp.user_id=$1)) and r.status in ('confirmed','pending_payment') order by t.start_at limit 5`, [id]),
    query(`select m.id,m.title,m.status,m.scheduled_at,t.name tournament_name,mp.registration_id from matches m join tournaments t on t.id=m.tournament_id join match_participants mp on mp.match_id=m.id join registration_participants rp on rp.registration_id=mp.registration_id where rp.user_id=$1 and m.status in ('scheduled','ongoing') and (m.status='ongoing' or m.scheduled_at>=now()) order by case when m.status='ongoing' then 0 else 1 end,m.scheduled_at asc limit 6`, [id]),
    query(`select r.id,r.registration_number,t.name tournament_name,t.start_at,g.name game_name from tournament_registrations r join tournaments t on t.id=r.tournament_id join games g on g.id=t.game_id where r.status='confirmed' and t.status in ('published','registration_closed','ongoing') and t.start_at>=now() and (r.player_id=$1 or exists(select 1 from registration_participants rp where rp.registration_id=r.id and rp.user_id=$1)) order by t.start_at asc limit 8`,[id]),
    query(`select id,kind,title,body,href,read_at,created_at from notifications where user_id=$1 order by created_at desc limit 5`, [id]),
    query('select count(*)::int count from notifications where user_id=$1 and read_at is null',[id]),
    query(`select id,title,body,published_at from site_announcements where active=true order by published_at desc nulls last limit 4`),
    query(`select id,title,description,href,pinned,display_order,starts_at,ends_at from upcoming_items where visible=true and (starts_at is null or starts_at<=now()) and (ends_at is null or ends_at>now()) order by pinned desc,display_order,created_at desc limit 6`),
  ]);
  const p = profile.rows[0];
  if (!p) return res.status(404).json({ error: 'Player profile not found.' });
  p.avatar_url=progressionForPoints(p.og_points).level>=Number(p.avatar_min_level)?(p.avatar_path?await signedAssetUrl(p.avatar_path):p.avatar_url):'';delete p.avatar_path;delete p.avatar_min_level;
  res.json({ profile: { ...p, ...progressionForPoints(p.og_points) }, upcomingTournaments: registrations.rows, matches: matches.rows, upcomingRegistrations:upcomingRegistrations.rows, notifications: notices.rows, unreadCount: Number(unread.rows[0]?.count||0), announcements: announcements.rows, upcoming: upcoming.rows });
});

platformRouter.get('/profile', requirePlayer, async (req, res) => {
  const result = await query(`select p.full_name,p.username,p.age,p.phone,p.upi_id,p.bio,p.avatar_asset_id,p.background_asset_id,p.banner_asset_id,coalesce(a.public_url,'') avatar_url,coalesce(b.public_url,'') background_url,coalesce(banner.public_url,'') banner_url,coalesce(a.min_level,1) avatar_min_level,coalesce(b.min_level,1) background_min_level,coalesce(banner.min_level,1) banner_min_level,ua.storage_path avatar_path,ub.storage_path background_path,ubanner.storage_path banner_path,
    coalesce((select sum(points) from og_points_ledger l where l.user_id=p.user_id),0)::int og_points from player_profiles p left join approved_profile_assets a on a.id=p.avatar_asset_id and a.approved=true left join approved_profile_assets b on b.id=p.background_asset_id and b.approved=true left join approved_profile_assets banner on banner.id=p.banner_asset_id and banner.approved=true left join uploaded_assets ua on ua.id=a.asset_id and ua.approved=true left join uploaded_assets ub on ub.id=b.asset_id and ub.approved=true left join uploaded_assets ubanner on ubanner.id=banner.asset_id and ubanner.approved=true where p.user_id=$1`, [userId(req)]);
  const profileAccounts=await query(`select a.game_id,g.name game_name,g.slug,a.game_identifier,a.updated_at from player_game_accounts a join games g on g.id=a.game_id where a.user_id=$1 order by g.name`,[userId(req)]);
  const profile=result.rows[0]||null;if(profile){const level=progressionForPoints(profile.og_points).level;const [avatar,background,banner]=await Promise.all([level>=Number(profile.avatar_min_level)?(profile.avatar_path?signedAssetUrl(profile.avatar_path):profile.avatar_url):'',level>=Number(profile.background_min_level)?(profile.background_path?signedAssetUrl(profile.background_path):profile.background_url):'',level>=Number(profile.banner_min_level)?(profile.banner_path?signedAssetUrl(profile.banner_path):profile.banner_url):'']);profile.avatar_url=avatar;profile.background_url=background;profile.banner_url=banner||background;delete profile.avatar_path;delete profile.background_path;delete profile.banner_path;delete profile.avatar_min_level;delete profile.background_min_level;delete profile.banner_min_level;profile.level=level;profile.gameAccounts=profileAccounts.rows;}
  res.json({ profile });
});

platformRouter.put('/profile', requirePlayer, async (req, res) => {
  const data = parse(z.object({ fullName: z.string().trim().min(2).max(80), username: z.string().trim().min(3).max(24).regex(/^[a-zA-Z0-9_]+$/), phone: z.string().trim().regex(/^\+?[1-9]\d{7,14}$/), upiId: z.string().trim().max(120).optional().or(z.literal('')), bio: z.string().trim().max(280).optional(), avatarAssetId: z.string().uuid().nullable().optional(), bannerAssetId: z.string().uuid().nullable().optional(), backgroundAssetId: z.string().uuid().nullable().optional(), gameAccounts:z.array(z.object({gameId:z.string().uuid(),identifier:z.string().trim().min(2).max(80).regex(/^[a-zA-Z0-9_.# -]+$/)})).max(50).refine(rows=>new Set(rows.map(row=>row.gameId)).size===rows.length,'Each game can only be added once.').optional() }), req.body);
  if (!data) return res.status(400).json({ error: 'Check the profile fields and try again.' });
  try {
    const result=await withTransaction(async (client) => {
      const locked=await client.query('select username from player_profiles where user_id=$1 for update',[userId(req)]);
      if(!locked.rowCount)return {error:'Player profile not found.',status:404};
      const oldUsername=locked.rows[0].username;
      const usernameChanged=oldUsername.toLowerCase()!==data.username.toLowerCase();
      if(!usernameChanged)data.username=oldUsername;
      if(usernameChanged){
        const recent=await client.query("select count(*)::int count from player_username_changes where user_id=$1 and changed_at>now()-interval '10 days'",[userId(req)]);
        if(Number(recent.rows[0].count)>=2)return {error:'You can change your username at most 2 times in any 10-day period.',status:429};
      }
      const points=await client.query('select coalesce(sum(points),0)::int points from og_points_ledger where user_id=$1',[userId(req)]);
      const currentLevel=progressionForPoints(points.rows[0]?.points||0).level;
      for (const [assetId, expectedType] of [[data.avatarAssetId,'avatar'],[data.bannerAssetId,'banner'],[data.backgroundAssetId,'background']].filter(([assetId])=>assetId)) {
        const asset = await client.query(`select 1 from approved_profile_assets apa join uploaded_assets ua on ua.id=apa.asset_id
          where apa.id=$1 and apa.approved=true and ua.approved=true and apa.asset_type=$2 and apa.min_level<=$3`, [assetId,expectedType,currentLevel]);
        if (!asset.rowCount) { const error = new Error(`Choose an approved ${expectedType} image available at your current level.`); error.status = 400; throw error; }
      }
      if(data.gameAccounts){
        const gameIds=data.gameAccounts.map(account=>account.gameId);
        if(gameIds.length){const activeGames=await client.query('select id from games where active=true and id=any($1::uuid[])',[gameIds]);if(activeGames.rowCount!==gameIds.length)return {error:'One or more selected games are no longer available.',status:400};}
      }
      await client.query(`update player_profiles set full_name=$2,username=$3,phone=$4,upi_id=$5,bio=$6,
        avatar_asset_id=case when $7 then $8::uuid else avatar_asset_id end,banner_asset_id=case when $9 then $10::uuid else banner_asset_id end,background_asset_id=case when $11 then $12::uuid else background_asset_id end,updated_at=now() where user_id=$1`, [userId(req), data.fullName, data.username, data.phone, data.upiId || null, data.bio || '', Object.hasOwn(data,'avatarAssetId'), data.avatarAssetId || null, Object.hasOwn(data,'bannerAssetId'), data.bannerAssetId || null, Object.hasOwn(data,'backgroundAssetId'), data.backgroundAssetId || null]);
      if(data.gameAccounts){
        const gameIds=data.gameAccounts.map(account=>account.gameId);
        await client.query('delete from player_game_accounts where user_id=$1 and not (game_id=any($2::uuid[]))',[userId(req),gameIds]);
        for(const account of data.gameAccounts)await client.query(`insert into player_game_accounts(user_id,game_id,game_identifier) values($1,$2,$3)
          on conflict(user_id,game_id) do update set game_identifier=excluded.game_identifier,updated_at=now()`,[userId(req),account.gameId,account.identifier]);
        await recordAudit(client,userId(req),'player_game_accounts_saved','player',userId(req),{count:data.gameAccounts.length});
      }
      if(usernameChanged)await client.query('insert into player_username_changes(user_id,old_username,new_username) values($1,$2,$3)',[userId(req),oldUsername,data.username]);
      return {ok:true};
    });
    if(result.error)return res.status(result.status).json({error:result.error});
    res.json({ ok: true, username: data.username });
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: error.constraint==='player_game_accounts_identifier_idx'?'That game username or UID is already linked to another player.':'That username is already taken.' });
    throw error;
  }
});

platformRouter.get('/sessions',requirePlayer,async(req,res)=>{
  const result=await query(`select sid=$2 as current,expire from sessions where sess->'user'->>'id'=$1 and expire>now() order by (sid=$2) desc,expire desc`,[userId(req),req.sessionID]);
  res.json({data:result.rows});
});
platformRouter.delete('/sessions/others',requirePlayer,async(req,res)=>{
  const revoked=await withTransaction(async(client)=>{
    const result=await client.query(`delete from sessions where sess->'user'->>'id'=$1 and sid<>$2`,[userId(req),req.sessionID]);
    await recordAudit(client,userId(req),'other_sessions_revoked','user',userId(req),{count:result.rowCount});
    return result.rowCount;
  });
  res.json({revoked});
});

platformRouter.post('/follows/:id', requirePlayer, async (req, res) => {
  if (!uuid.safeParse(req.params.id).success) return res.status(400).json({ error: 'Invalid player.' });
  if (req.params.id === userId(req)) return res.status(400).json({ error: 'You cannot follow your own account.' });
  const target = await query("select id from users where id=$1 and role='player' and status='active'", [req.params.id]);
  if (!target.rowCount) return res.status(404).json({ error: 'Player not found.' });
  const added=await query('insert into follows(follower_id,followed_id) values($1,$2) on conflict do nothing returning follower_id', [userId(req), req.params.id]);
  if(added.rowCount)await query(`insert into notifications(user_id,kind,title,body,href) values($1,'follow','New follower','A player followed you.','/players')`, [req.params.id]);
  res.status(201).json({ following: true });
});
platformRouter.get('/follows/:id', requirePlayer, async (req,res)=>{
  const result=await query('select 1 from follows where follower_id=$1 and followed_id=$2',[userId(req),req.params.id]);res.json({following:Boolean(result.rowCount)});
});
platformRouter.delete('/follows/:id', requirePlayer, async (req, res) => {
  await query('delete from follows where follower_id=$1 and followed_id=$2', [userId(req), req.params.id]);
  res.json({ following: false });
});

platformRouter.get('/notifications', requirePlayer, async (req, res) => {
  const { page, limit } = pageParams(req);
  const result = await query('select id,kind,title,body,href,read_at,created_at,count(*) over() total_count from notifications where user_id=$1 order by created_at desc limit $2 offset $3', [userId(req), limit, (page - 1) * limit]);
  res.json({ data: result.rows, page, limit, total: Number(result.rows[0]?.total_count || 0) });
});
platformRouter.patch('/notifications/read-all', requirePlayer, async (req, res) => {
  await query('update notifications set read_at=coalesce(read_at,now()) where user_id=$1', [userId(req)]);
  res.json({ ok: true });
});
platformRouter.patch('/notifications/:id/read', requirePlayer, async (req, res) => {
  await query('update notifications set read_at=coalesce(read_at,now()) where id=$1 and user_id=$2', [req.params.id, userId(req)]);
  res.json({ ok: true });
});

platformRouter.get('/teams', requirePlayer, async (req, res) => {
  const result = await query(`select t.id,t.name,t.game_id,g.name game_name,f.id format_id,f.name format_name,f.participant_count,t.leader_user_id,t.logo_storage_path,
    coalesce(json_agg(json_build_object('userId',tm.user_id,'username',p.username,'name',p.full_name,'role',tm.role,'gameIdentifier',account.game_identifier) order by tm.joined_at) filter(where tm.user_id is not null),'[]') roster,
    coalesce((select json_agg(json_build_object('guestId',gm.id,'name',gm.display_name,'username',gm.external_handle,'role','guest') order by gm.created_at) from team_guest_members gm where gm.team_id=t.id),'[]') manual_roster,
    avatar_path.storage_path leader_avatar_path,coalesce(avatar.public_url,'') leader_avatar_url,coalesce(avatar.min_level,1) leader_avatar_min_level,coalesce((select sum(points) from og_points_ledger points where points.user_id=t.leader_user_id),0)::int leader_og_points
    from team_members mine join teams t on t.id=mine.team_id join games g on g.id=t.game_id join game_formats f on f.id=t.format_id
    left join team_members tm on tm.team_id=t.id left join player_profiles p on p.user_id=tm.user_id left join player_game_accounts account on account.user_id=tm.user_id and account.game_id=t.game_id
    left join player_profiles leader on leader.user_id=t.leader_user_id left join approved_profile_assets avatar on avatar.id=leader.avatar_asset_id and avatar.asset_type='avatar' and avatar.approved=true
    left join uploaded_assets avatar_path on avatar_path.id=avatar.asset_id and avatar_path.approved=true
    where mine.user_id=$1 and t.active=true group by t.id,g.name,f.id,f.name,f.participant_count,avatar_path.storage_path,avatar.public_url,avatar.min_level order by g.name,t.name`, [userId(req)]);
  const data=await Promise.all(result.rows.map(async row=>{const [logo,leaderAvatar]=await Promise.all([row.logo_storage_path?signedAssetUrl(row.logo_storage_path):'',progressionForPoints(row.leader_og_points).level>=Number(row.leader_avatar_min_level)?(row.leader_avatar_path?signedAssetUrl(row.leader_avatar_path):row.leader_avatar_url):'']);delete row.logo_storage_path;delete row.leader_avatar_path;delete row.leader_avatar_min_level;delete row.leader_og_points;return {...row,roster:[...row.roster,...row.manual_roster],logo_url:logo,leader_avatar_url:leaderAvatar};}));
  res.json({ data });
});
platformRouter.post('/teams', requirePlayer, async (req, res) => {
  const data = parse(z.object({ gameId: z.string().uuid(), formatId: z.string().uuid(), name: z.string().trim().min(2).max(48) }), req.body);
  if (!data) return res.status(400).json({ error: 'Provide a game, format, and team name.' });
  const team = await withTransaction(async (client) => {
    const format = await client.query('select f.id,f.game_id,f.name,f.participant_count from game_formats f join games g on g.id=f.game_id where f.id=$1 and f.game_id=$2 and f.active=true and g.active=true', [data.formatId, data.gameId]);
    if (!format.rowCount) return { error: 'That format is not available for the selected game.' };
    if(Number(format.rows[0].participant_count)===1)return {error:'Solo formats do not need a team. Add your game username or UID to your profile and join solo tournaments directly.'};
    const gameAccount=await client.query('select 1 from player_game_accounts where user_id=$1 and game_id=$2',[userId(req),data.gameId]);
    if(!gameAccount.rowCount)return {error:'Add your username or UID for this game in Edit Profile before creating a team.'};
    const existingName = await client.query('select 1 from teams where game_id=$1 and lower(name)=lower($2) limit 1', [data.gameId, data.name]);
    if (existingName.rowCount) return { error: 'Team name already exists for this game.' };
    const occupied = await client.query('select 1 from team_members tm join teams t on t.id=tm.team_id where tm.user_id=$1 and t.game_id=$2 and t.active=true', [userId(req), data.gameId]);
    if (occupied.rowCount) return { error: 'You already belong to an active team for this game.' };
    const created = await client.query('insert into teams(game_id,format_id,name,leader_user_id,created_by) values($1,$2,$3,$4,$4) returning id,name', [data.gameId, data.formatId, data.name, userId(req)]);
    await client.query("insert into team_members(team_id,user_id,role) values($1,$2,'leader')", [created.rows[0].id, userId(req)]);
    return { team: created.rows[0] };
  });
  if (team.error) return res.status(400).json({ error: team.error });
  res.status(201).json(team);
});
platformRouter.post('/teams/:id/logo',requirePlayer,uploadImage.single('logo'),async(req,res)=>{
  if(!uuid.safeParse(req.params.id).success)return res.status(400).json({error:'Choose a valid team.'});
  const file=req.file,detected=file&&imageType(file.buffer);
  if(!file||!detected||file.mimetype!==detected.mime)return res.status(400).json({error:'Choose a PNG, JPEG, or WebP team logo under 4 MB.'});
  const path=`teams/${req.params.id}/${randomUUID()}.${detected.ext}`;let uploaded=false;
  try{
    const result=await withTransaction(async(client)=>{
      const team=await client.query('select t.id,t.logo_storage_path,f.participant_count from teams t join game_formats f on f.id=t.format_id where t.id=$1 and t.active=true and t.leader_user_id=$2 for update',[req.params.id,userId(req)]);
      if(!team.rowCount)return {error:'Only the active team leader can change this logo.'};
      if(Number(team.rows[0].participant_count)===1)return {error:'Solo formats use the player profile picture instead of a team logo.'};
      await uploadProfileAsset(path,file.buffer,detected.mime);uploaded=true;
      await client.query('update teams set logo_storage_path=$2,updated_at=now() where id=$1',[team.rows[0].id,path]);
      await recordAudit(client,userId(req),'team_logo_updated','team',team.rows[0].id);
      return {oldPath:team.rows[0].logo_storage_path};
    });
    if(result.error){if(uploaded)await removeProfileAsset(path);return res.status(403).json({error:result.error});}
    if(result.oldPath)await removeProfileAsset(result.oldPath);
    res.json({logoUrl:await signedAssetUrl(path)});
  }catch(error){if(uploaded)try{await removeProfileAsset(path);}catch{}throw error;}
});
platformRouter.post('/teams/:id/manual-members',requirePlayer,async(req,res)=>{
  if(!uuid.safeParse(req.params.id).success)return res.status(400).json({error:'Choose a valid team.'});
  const data=parse(z.object({name:z.string().trim().min(2).max(80),usernameOrUid:z.string().trim().min(2).max(48).regex(/^[a-zA-Z0-9_.#-]+$/)}),req.body);
  if(!data)return res.status(400).json({error:'Enter the player name and username or UID.'});
  const result=await withTransaction(async(client)=>{
    const team=await client.query('select t.id,t.name,t.leader_user_id,f.participant_count from teams t join game_formats f on f.id=t.format_id where t.id=$1 and t.active=true for update',[req.params.id]);
    if(!team.rowCount||team.rows[0].leader_user_id!==userId(req))return {error:'Only the team leader can add roster members.',status:403};
    if(Number(team.rows[0].participant_count)===1)return {error:'Solo formats do not have team rosters.',status:400};
    const counts=await client.query(`select (select count(*) from team_members where team_id=$1)+(select count(*) from team_guest_members where team_id=$1) count`,[req.params.id]);
    if(Number(counts.rows[0].count)>=Number(team.rows[0].participant_count))return {error:'This roster is already full.',status:409};
    const existing=await client.query(`select 1 from team_guest_members where team_id=$1 and lower(external_handle)=lower($2)
      union all select 1 from team_members tm join player_profiles p on p.user_id=tm.user_id
      where tm.team_id=$1 and lower(p.username)=lower($2) limit 1`,[req.params.id,data.usernameOrUid]);
    if(existing.rowCount)return {error:'That username or UID is already on this team.',status:409};
    const member=await client.query('insert into team_guest_members(team_id,display_name,external_handle) values($1,$2,$3) returning id,display_name name,external_handle username',[req.params.id,data.name,data.usernameOrUid]);
    await recordAudit(client,userId(req),'team_manual_member_added','team',req.params.id,{handle:data.usernameOrUid});
    return {member:member.rows[0]};
  });
  if(result.error)return res.status(result.status||400).json({error:result.error});
  res.status(201).json(result);
});
platformRouter.delete('/teams/:id/manual-members/:memberId',requirePlayer,async(req,res)=>{
  const result=await withTransaction(async(client)=>{
    const team=await client.query('select leader_user_id from teams where id=$1 and active=true for update',[req.params.id]);
    if(!team.rowCount||team.rows[0].leader_user_id!==userId(req))return {error:'Only the team leader can remove roster members.',status:403};
    const removed=await client.query('delete from team_guest_members where id=$1 and team_id=$2 returning id',[req.params.memberId,req.params.id]);
    if(!removed.rowCount)return {error:'Manual roster member not found.',status:404};
    await recordAudit(client,userId(req),'team_manual_member_removed','team',req.params.id,{memberId:req.params.memberId});
    return {ok:true};
  });
  if(result.error)return res.status(result.status).json({error:result.error});res.json(result);
});
platformRouter.delete('/teams/:id/members/:memberId',requirePlayer,async(req,res)=>{
  if(!uuid.safeParse(req.params.id).success||!uuid.safeParse(req.params.memberId).success)return res.status(400).json({error:'Choose a valid team member.'});
  const result=await withTransaction(async(client)=>{
    const team=await client.query('select id,leader_user_id from teams where id=$1 and active=true for update',[req.params.id]);
    if(!team.rowCount)return {error:'Team not found.',status:404};
    if(team.rows[0].leader_user_id!==userId(req))return {error:'Only the team leader can remove another member.',status:403};
    if(req.params.memberId===userId(req))return {error:'Use Leave team to leave your own roster.',status:400};
    const member=await client.query('select role from team_members where team_id=$1 and user_id=$2 for update',[req.params.id,req.params.memberId]);
    if(!member.rowCount)return {error:'Team member not found.',status:404};
    const activeEntry=await client.query(`select 1 from registration_participants rp join tournament_registrations r on r.id=rp.registration_id join tournaments t on t.id=r.tournament_id
      where r.team_id=$1 and rp.user_id=$2 and r.status in ('pending_payment','confirmed') and t.status not in ('completed','cancelled','archived') limit 1`,[req.params.id,req.params.memberId]);
    if(activeEntry.rowCount)return {error:'This player is part of an active tournament entry and cannot be removed yet.',status:409};
    await client.query('delete from team_members where team_id=$1 and user_id=$2',[req.params.id,req.params.memberId]);
    await client.query("update team_invitations set status='cancelled',responded_at=now() where team_id=$1 and invited_user_id=$2 and status='pending'",[req.params.id,req.params.memberId]);
    await recordAudit(client,userId(req),'team_member_removed','team',req.params.id,{memberId:req.params.memberId});
    return {ok:true};
  });
  if(result.error)return res.status(result.status||400).json({error:result.error});res.json(result);
});
platformRouter.get('/teams/invitations', requirePlayer, async (req, res) => {
  const result = await query(`select i.id,i.status,i.created_at,t.id team_id,t.name team_name,g.name game_name,p.username invited_by
    from team_invitations i join teams t on t.id=i.team_id join games g on g.id=t.game_id join player_profiles p on p.user_id=i.invited_by
    where i.invited_user_id=$1 and i.status='pending' order by i.created_at desc`, [userId(req)]);
  res.json({ data: result.rows });
});
platformRouter.post('/teams/:id/invitations', requirePlayer, async (req, res) => {
  const data = parse(z.object({ username: z.string().trim().min(3).max(24) }), req.body);
  if (!data || !uuid.safeParse(req.params.id).success) return res.status(400).json({ error: 'Invalid invitation.' });
  const result = await withTransaction(async (client) => {
    const team = await client.query('select id,name,game_id,format_id,leader_user_id from teams where id=$1 and active=true for update', [req.params.id]);
    if (!team.rowCount || team.rows[0].leader_user_id !== userId(req)) return { error: 'Only the team leader can invite players.' };
    const invitee = await client.query("select u.id from users u join player_profiles p on p.user_id=u.id where lower(p.username)=lower($1) and u.status='active' and u.role='player'", [data.username]);
    if (!invitee.rowCount) return { error: 'No eligible player has that username.' };
    if (invitee.rows[0].id === userId(req)) return { error: 'You are already the team leader.' };
    const gameAccount=await client.query('select 1 from player_game_accounts where user_id=$1 and game_id=$2',[invitee.rows[0].id,team.rows[0].game_id]);
    if(!gameAccount.rowCount)return {error:'That player must add their username or UID for this game in their profile before joining the team.'};
    const prior = await client.query('select 1 from team_members where team_id=$1 and user_id=$2', [team.rows[0].id, invitee.rows[0].id]);
    if (prior.rowCount) return { error: 'That player is already on this team.' };
    const format = await client.query('select participant_count from game_formats where id=$1', [team.rows[0].format_id]);
    const count = await client.query('select (select count(*) from team_members where team_id=$1)+(select count(*) from team_guest_members where team_id=$1) n', [team.rows[0].id]);
    if (Number(count.rows[0].n) >= Number(format.rows[0].participant_count)) return { error: 'This roster is already full.' };
    const pending = await client.query("insert into team_invitations(team_id,invited_user_id,invited_by) values($1,$2,$3) on conflict(team_id,invited_user_id) do update set status='pending',invited_by=excluded.invited_by,created_at=now(),responded_at=null where team_invitations.status in ('declined','cancelled') returning id", [team.rows[0].id, invitee.rows[0].id, userId(req)]);
    if (!pending.rowCount) return { error: 'An invitation is already pending for that player.' };
    await client.query(`insert into notifications(user_id,kind,title,body,href) values($1,'team_invitation','Squad invitation',$2,'/teams')`, [invitee.rows[0].id, `You were invited to ${team.rows[0].name}.`]);
    return { invitationId: pending.rows[0].id };
  });
  if (result.error) return res.status(400).json({ error: result.error });
  res.status(201).json(result);
});
platformRouter.patch('/teams/invitations/:id', requirePlayer, async (req, res) => {
  const data = parse(z.object({ action: z.enum(['accept','decline']) }), req.body);
  if (!data) return res.status(400).json({ error: 'Choose accept or decline.' });
  const result = await withTransaction(async (client) => {
    const inv = await client.query(`select i.*,t.game_id,t.format_id,t.name from team_invitations i join teams t on t.id=i.team_id where i.id=$1 and i.invited_user_id=$2 and i.status='pending' for update`, [req.params.id, userId(req)]);
    if (!inv.rowCount) return { error: 'Invitation not found or no longer pending.' };
    if (data.action === 'decline') {
      await client.query("update team_invitations set status='declined',responded_at=now() where id=$1", [req.params.id]);
      return { status: 'declined' };
    }
    const linkedGame=await client.query('select 1 from player_game_accounts where user_id=$1 and game_id=$2',[userId(req),inv.rows[0].game_id]);
    if(!linkedGame.rowCount)return {error:'Add your username or UID for this game in your profile before accepting the invitation.'};
    const occupied = await client.query('select 1 from team_members tm join teams t on t.id=tm.team_id where tm.user_id=$1 and t.game_id=$2 and t.active=true', [userId(req), inv.rows[0].game_id]);
    if (occupied.rowCount) return { error: 'Leave your current team for this game before accepting.' };
    const count = await client.query('select (select count(*) from team_members where team_id=$1)+(select count(*) from team_guest_members where team_id=$1) n', [inv.rows[0].team_id]);
    const format = await client.query('select participant_count from game_formats where id=$1', [inv.rows[0].format_id]);
    if (Number(count.rows[0].n) >= Number(format.rows[0].participant_count)) return { error: 'That team roster is full.' };
    await client.query("insert into team_members(team_id,user_id,role) values($1,$2,'member')", [inv.rows[0].team_id, userId(req)]);
    await client.query("update team_invitations set status='accepted',responded_at=now() where id=$1", [req.params.id]);
    return { status: 'accepted' };
  });
  if (result.error) return res.status(400).json({ error: result.error });
  res.json(result);
});
platformRouter.patch('/teams/:id/leader',requirePlayer,async(req,res)=>{
  const data=parse(z.object({userId:z.string().uuid()}),req.body);if(!data)return res.status(400).json({error:'Choose a valid team member.'});
  const result=await withTransaction(async(client)=>{const team=await client.query('select id,leader_user_id from teams where id=$1 and active=true for update',[req.params.id]);if(!team.rowCount||team.rows[0].leader_user_id!==userId(req))return {error:'Only the current team leader can transfer leadership.'};const member=await client.query('select 1 from team_members where team_id=$1 and user_id=$2',[req.params.id,data.userId]);if(!member.rowCount)return {error:'The new leader must be on the team roster.'};await client.query("update team_members set role='member' where team_id=$1",[req.params.id]);await client.query("update team_members set role='leader' where team_id=$1 and user_id=$2",[req.params.id,data.userId]);await client.query('update teams set leader_user_id=$2,updated_at=now() where id=$1',[req.params.id,data.userId]);await recordAudit(client,userId(req),'team_leader_transferred','team',req.params.id,{newLeaderId:data.userId});return {ok:true};});if(result.error)return res.status(403).json({error:result.error});res.json(result);
});
platformRouter.delete('/teams/:id/membership',requirePlayer,async(req,res)=>{
  const result=await withTransaction(async(client)=>{
    const team=await client.query('select id,name,leader_user_id from teams where id=$1 and active=true for update',[req.params.id]);
    if(!team.rowCount)return {error:'Team not found.'};
    const member=await client.query('select role from team_members where team_id=$1 and user_id=$2 for update',[req.params.id,userId(req)]);
    if(!member.rowCount)return {error:'You are not on this roster.'};
    const activeEntry=await client.query(`select 1 from registration_participants rp join tournament_registrations r on r.id=rp.registration_id join tournaments t on t.id=r.tournament_id
      where r.team_id=$1 and rp.user_id=$2 and r.status in ('pending_payment','confirmed') and t.status not in ('completed','cancelled','archived') limit 1`,[req.params.id,userId(req)]);
    if(activeEntry.rowCount)return {error:'You are part of an active tournament entry and cannot leave this team yet.'};
    const isLeader=team.rows[0].leader_user_id===userId(req);
    let nextLeader=null;
    if(isLeader){
      const next=await client.query("select user_id from team_members where team_id=$1 and user_id<>$2 order by joined_at asc,user_id asc limit 1",[req.params.id,userId(req)]);
      nextLeader=next.rows[0]?.user_id||null;
      if(nextLeader){
        await client.query("update team_members set role='member' where team_id=$1",[req.params.id]);
        await client.query("update team_members set role='leader' where team_id=$1 and user_id=$2",[req.params.id,nextLeader]);
        await client.query('update teams set leader_user_id=$2,updated_at=now() where id=$1',[req.params.id,nextLeader]);
        await client.query(`insert into notifications(user_id,kind,title,body,href) values($1,'team_leadership','You are now team leader',$2,'/teams')`,[nextLeader,`Leadership of ${team.rows[0].name} transferred to you.`]);
      }
    }
    await client.query('delete from team_members where team_id=$1 and user_id=$2',[req.params.id,userId(req)]);
    if(isLeader&&!nextLeader)await client.query('update teams set active=false,leader_user_id=null,updated_at=now() where id=$1',[req.params.id]);
    await client.query("update team_invitations set status='cancelled',responded_at=now() where team_id=$1 and invited_user_id=$2 and status='pending'",[req.params.id,userId(req)]);
    await recordAudit(client,userId(req),'team_member_left','team',req.params.id,{newLeaderId:nextLeader});
    return {ok:true,newLeaderId:nextLeader};
  });
  if(result.error)return res.status(409).json({error:result.error});res.json(result);
});
platformRouter.delete('/teams/:id',requirePlayer,async(req,res)=>{
  if(!uuid.safeParse(req.params.id).success)return res.status(400).json({error:'Choose a valid team.'});
  const result=await withTransaction(async(client)=>{
    const team=await client.query('select id,name,leader_user_id from teams where id=$1 and active=true for update',[req.params.id]);
    if(!team.rowCount)return {error:'Team not found.',status:404};
    if(team.rows[0].leader_user_id!==userId(req))return {error:'Only the team leader can delete this team.',status:403};
    const activeRegistration=await client.query(`select 1 from tournament_registrations r join tournaments t on t.id=r.tournament_id
      where r.team_id=$1 and r.status in ('pending_payment','confirmed') and t.status not in ('completed','cancelled','archived') limit 1`,[req.params.id]);
    if(activeRegistration.rowCount)return {error:'This team has an active tournament entry. It can be deleted after that entry is completed or cancelled.',status:409};
    await client.query("update team_invitations set status='cancelled',responded_at=now() where team_id=$1 and status='pending'",[req.params.id]);
    await client.query('update teams set active=false,leader_user_id=null,updated_at=now() where id=$1',[req.params.id]);
    await recordAudit(client,userId(req),'team_deactivated','team',req.params.id,{name:team.rows[0].name});
    return {ok:true};
  });
  if(result.error)return res.status(result.status||400).json({error:result.error});res.json(result);
});

platformRouter.post('/tournaments/:id/register', requirePlayer, async (req, res) => {
  if (!uuid.safeParse(req.params.id).success) return res.status(400).json({ error: 'Invalid tournament.' });
  const data = parse(z.object({ teamId: z.string().uuid().optional() }), req.body || {});
  if (!data) return res.status(400).json({ error: 'Invalid registration details.' });
  const result = await withTransaction(async (client) => {
    const paymentSetting=await client.query("select value from site_settings where key='payment_configuration' for share");
    const selectedPayment=paymentSetting.rows[0]?.value||{method:'razorpay',upiId:'',qrPath:null};
    const tournament = await client.query(`select t.id,t.name,t.status,t.start_at,t.registration_opens_at,t.registration_deadline,t.visibility_deadline,t.visibility_mode,t.capacity,t.entry_fee_paise,t.format_id,f.participant_count,f.name format_name
      from tournaments t join game_formats f on f.id=t.format_id where t.id=$1 for update`, [req.params.id]);
    if (!tournament.rowCount) return { error: 'Tournament not found.', status: 404 };
    const t = tournament.rows[0];
    const now=new Date();
    if(t.status!=='published'||!isTournamentVisible(t,now))return {error:'This tournament is not accepting registrations.',status:409};
    if(t.registration_opens_at&&new Date(t.registration_opens_at)>now)return {error:`Registration opens ${new Date(t.registration_opens_at).toLocaleString('en-IN',{timeZone:t.timezone||'Asia/Kolkata'})}.`,status:409};
    if(new Date(t.registration_deadline)<=now||new Date(t.start_at)<=now)return {error:'Registration is closed.',status:409};
    let teamId = data.teamId || null;
    let participants;
    if (Number(t.participant_count) === 1) {
      if (teamId) return { error: 'This tournament accepts individual entries only.', status: 400 };
      participants = [{ user_id: userId(req) }];
    } else {
      if (!teamId) return { error: 'Select a team before registering.', status: 400 };
      const team = await client.query('select t.id,t.game_id,t.format_id,t.leader_user_id from teams t join team_members tm on tm.team_id=t.id where t.id=$1 and tm.user_id=$2 and t.active=true for update', [teamId, userId(req)]);
      if (!team.rowCount || team.rows[0].format_id !== t.format_id) return { error: 'Choose an eligible team using the tournament format.', status: 400 };
      const [members,guests] = await Promise.all([client.query('select user_id from team_members where team_id=$1 order by joined_at', [teamId]),client.query('select display_name,external_handle from team_guest_members where team_id=$1 order by created_at',[teamId])]);
      if (members.rowCount+guests.rowCount !== Number(t.participant_count)) return { error: `The team must have ${t.participant_count} members before registering.`, status: 400 };
      if (!team.rows[0].leader_user_id || !members.rows.some((m) => m.user_id === team.rows[0].leader_user_id)) return { error: 'Assign a team leader before registering.', status: 400 };
      participants = [...members.rows,...guests.rows.map(guest=>({external_name:guest.display_name,external_handle:guest.external_handle}))];
    }
    await client.query(`update tournament_registrations set status='cancelled',payment_status='failed' where tournament_id=$1 and status='pending_payment' and reserved_until<=now()`, [t.id]);
    const duplicate = await client.query(`select 1 from tournament_registrations where tournament_id=$1 and (player_id=$2 or team_id=$3) and status in ('confirmed','pending_payment') and (reserved_until is null or reserved_until>now())`, [t.id, teamId ? null : userId(req), teamId]);
    if (duplicate.rowCount) return { error: 'You or your team already has an active registration.', status: 409 };
    const capacity = await client.query(`select count(*)::int n from tournament_registrations where tournament_id=$1 and (status='confirmed' or (status='pending_payment' and (payment_status='pending_verification' or reserved_until>now())))`, [t.id]);
    if (t.capacity && Number(capacity.rows[0].n) >= Number(t.capacity)) return { error: 'Tournament capacity has been reached.', status: 409 };
    const number=await client.query('update registration_counters set last_number=last_number+1 where singleton_id=1 returning last_number');
    const registrationNumber=Number(number.rows[0].last_number);
    const reference = `OEG-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2,7).toUpperCase()}`;
    const paidEntry = Number(t.entry_fee_paise) > 0;
    if(paidEntry&&selectedPayment.method==='manual'&&(!selectedPayment.qrPath||!selectedPayment.upiId))return {error:'Manual UPI payment is not fully configured. Contact tournament support.',status:503};
    const method=paidEntry?(selectedPayment.method==='manual'?'manual':'razorpay'):'razorpay';
    const inserted = await client.query(`insert into tournament_registrations(registration_number,reference,tournament_id,player_id,team_id,status,payment_status,reserved_until,payment_method,payment_qr_path,payment_upi_id)
      values($1,$2,$3,$4,$5,$6,$7,case when $6='pending_payment' then now()+make_interval(mins=>$8) else null end,$9,$10,$11) returning id,registration_number,reference,status,payment_status,reserved_until,payment_method`,
      [registrationNumber,reference,t.id,teamId ? null : userId(req),teamId,paidEntry ? 'pending_payment' : 'confirmed',paidEntry ? 'pending' : 'not_required',Number(process.env.PAYMENT_RESERVATION_TTL_MINUTES || 15),method,paidEntry&&method==='manual'?selectedPayment.qrPath:null,paidEntry&&method==='manual'?selectedPayment.upiId:null]);
    for (const member of participants) {
      if(member.user_id)await client.query('insert into registration_participants(registration_id,user_id) values($1,$2)',[inserted.rows[0].id,member.user_id]);
      else await client.query('insert into registration_participants(registration_id,external_name,external_handle) values($1,$2,$3)',[inserted.rows[0].id,member.external_name,member.external_handle]);
    }
    await client.query(`insert into notifications(user_id,kind,title,body,href) values($1,'registration','Tournament registration',$2,$3)`, [userId(req), paidEntry ? `Your spot is reserved for ${t.name}. Complete payment before the reservation expires.` : `Your registration for ${t.name} is confirmed.`, `/tournaments/${t.id}`]);
    await notifyAdmin(client,'registration','Tournament registration',`REG-${String(registrationNumber).padStart(6,'0')} · ${reference} was created.`,`/pass/ads/registrations`);
    return { registration: inserted.rows[0], amountPaise: Number(t.entry_fee_paise), tournamentName: t.name,paymentMethod:method };
  });
  if (result.error) return res.status(result.status || 400).json({ error: result.error });
  res.status(201).json(result);
});

platformRouter.get('/matches', requirePlayer, async (req, res) => {
  const filter = ['upcoming','ongoing','past'].includes(req.query.filter) ? req.query.filter : 'upcoming';
  const id = userId(req);
  const result = await query(`select m.id,m.title,m.status,m.scheduled_at,m.room_releases_at,t.name tournament_name,g.name game_name,mp.registration_id,false is_tournament_entry,
    case when m.room_releases_at is not null and m.room_releases_at<=now() then m.room_id else null end room_id,
    case when m.room_releases_at is not null and m.room_releases_at<=now() then m.room_password else null end room_password,
    mr.placement
    from matches m join tournaments t on t.id=m.tournament_id join games g on g.id=t.game_id
    join match_participants mp on mp.match_id=m.id join registration_participants rp on rp.registration_id=mp.registration_id and rp.user_id=$1
    left join match_results mr on mr.match_id=m.id and mr.registration_id=mp.registration_id and not exists(select 1 from match_results newer where newer.correction_of=mr.id)
    where ($2='upcoming' and m.status='scheduled' and m.scheduled_at>now()) or ($2='ongoing' and m.status='ongoing') or ($2='past' and m.status in ('completed','cancelled'))
    order by m.scheduled_at ${filter === 'past' ? 'desc' : 'asc'} limit 50`, [id, filter]);
  res.json({ data:result.rows });
});

platformRouter.get('/rewards', requirePlayer, async (req, res) => {
  const id = userId(req);
  const [og,xp,cash] = await Promise.all([
    query('select points,reason,created_at from og_points_ledger where user_id=$1 order by created_at desc limit 50',[id]),
    query('select points,reason,created_at from xp_points_ledger where user_id=$1 order by created_at desc limit 50',[id]),
    query(`select c.amount_paise,c.status,c.created_at,t.name tournament_name from cash_reward_records c left join reward_transactions r on r.id=c.reward_transaction_id left join match_results mr on mr.id=r.result_id left join matches m on m.id=mr.match_id left join tournaments t on t.id=m.tournament_id where c.user_id=$1 or exists(select 1 from team_members tm where tm.team_id=c.team_id and tm.user_id=$1) order by c.created_at desc limit 50`,[id]),
  ]);
  const totals = await query(`select coalesce(sum(amount_paise) filter(where status='confirmed'),0)::int confirmed,coalesce(sum(amount_paise) filter(where status in ('pending','confirmed')),0)::int pending,coalesce(sum(amount_paise) filter(where status='paid'),0)::int paid from cash_reward_records c where c.user_id=$1 or exists(select 1 from team_members tm where tm.team_id=c.team_id and tm.user_id=$1)`,[id]);
  res.json({ ogPoints: og.rows, xpPoints: xp.rows, cash: { ...totals.rows[0], history: cash.rows }, redemption: { available: false, label: 'Coming Soon' } });
});

platformRouter.get('/support/tickets', requirePlayer, async (req, res) => {
  const result = await query(`select t.id,t.category,t.subject,t.status,t.created_at,t.updated_at,
    coalesce(json_agg(json_build_object('id',m.id,'senderRole',m.sender_role,'message',m.message,'createdAt',m.created_at) order by m.created_at) filter(where m.id is not null),'[]') messages
    from support_tickets t left join support_messages m on m.ticket_id=t.id where t.user_id=$1 group by t.id order by t.updated_at desc`, [userId(req)]);
  res.json({ data: result.rows });
});
platformRouter.post('/support/tickets', requirePlayer, async (req, res) => {
  const data = parse(z.object({ category: z.enum(['account','tournament','payment','team','technical','other']), subject: z.string().trim().min(4).max(120), message: z.string().trim().min(10).max(4000) }), req.body);
  if (!data) return res.status(400).json({ error: 'Check the support ticket details.' });
  const ticket = await withTransaction(async (client) => {
    const created = await client.query('insert into support_tickets(user_id,category,subject) values($1,$2,$3) returning id', [userId(req),data.category,data.subject]);
    await client.query("insert into support_messages(ticket_id,sender_id,sender_role,message) values($1,$2,'player',$3)", [created.rows[0].id,userId(req),data.message]);
    await notifyAdmin(client,'support','New support ticket',data.subject,'/pass/ads/support');
    return created.rows[0];
  });
  res.status(201).json({ ticket });
});
platformRouter.post('/support/tickets/:id/messages', requirePlayer, async (req, res) => {
  const data = parse(z.object({ message: z.string().trim().min(2).max(4000) }), req.body);
  if (!data) return res.status(400).json({ error: 'Enter a reply.' });
  const result = await query(`insert into support_messages(ticket_id,sender_id,sender_role,message)
    select id,$1,'player',$3 from support_tickets where id=$2 and user_id=$1 and status in ('open','in_progress') returning id,created_at`, [userId(req),req.params.id,data.message]);
  if (!result.rowCount) return res.status(404).json({ error: 'Ticket not found or closed.' });
  await query('update support_tickets set updated_at=now() where id=$1',[req.params.id]);
  res.status(201).json({ message: result.rows[0] });
});

// Administrator dashboard and management APIs.
platformRouter.get('/admin/dashboard', requireAdmin, async (req, res) => {
  const [counts, revenue, monthly, activities, pending] = await Promise.all([
    query(`select (select count(*) from users where role='player')::int players,
      (select count(*) from users where role='player' and email_verified_at is not null)::int verified,
      (select count(*) from users where role='player' and status='active')::int active,
      (select count(*) from users where role='player' and status='suspended')::int suspended,
      (select count(*) from games where active=true)::int games,
      (select count(*) from tournaments)::int tournaments,
      (select count(*) from tournaments where status='published' and start_at>now())::int upcoming_tournaments,
      (select count(*) from tournaments where status in ('completed','archived'))::int past_tournaments,
      (select count(*) from tournament_registrations where status='confirmed')::int registrations`),
    query(`select coalesce((select sum(amount_paise) from payments where status='captured'),0)::bigint gross_collected_paise,
      coalesce((select sum(amount_paise) from refunds where status='completed'),0)::bigint refunded_paise,
      coalesce((select sum(amount_paise) from payout_records where status='paid'),0)::bigint paid_out_paise,
      coalesce((select sum(amount_paise) from payments where status='captured' and created_at>=date_trunc('month',now())),0)::bigint monthly_gross_paise`),
    query(`select to_char(date_trunc('month',d),'YYYY-MM') as month_label,coalesce(sum(p.amount_paise),0)::bigint gross_paise from generate_series(date_trunc('month',now())-interval '5 months',date_trunc('month',now()),interval '1 month') d left join payments p on date_trunc('month',p.created_at)=d and p.status='captured' group by d order by d`),
    query('select event,subject_type,subject_id,created_at from audit_logs order by created_at desc limit 8'),
    query(`select (select count(*) from refunds where status='requested') refunds,(select count(*) from support_tickets where status in ('open','in_progress')) support,(select count(*) from matches where status='scheduled' and scheduled_at>now()) matches`),
  ]);
  res.json({ counts: counts.rows[0], finance: revenue.rows[0], monthly: monthly.rows, recentActivity: activities.rows, pending: pending.rows[0], financeDefinitions: { grossCollected: 'Captured entry-fee payments before refunds.', refunds: 'Completed refunds.', payouts: 'Cash rewards recorded as paid; not deducted from gross collections.' } });
});

platformRouter.get('/admin/notifications', requireAdmin, async (req, res) => {
  const result = await query('select id,kind,title,body,href,read_at,created_at from admin_notifications order by created_at desc limit 100');
  res.json({ data: result.rows, unreadCount: result.rows.filter((row) => !row.read_at).length });
});
platformRouter.patch('/admin/notifications/read-all', requireAdmin, async (req, res) => {
  await query('update admin_notifications set read_at=coalesce(read_at,now())');
  res.json({ ok: true });
});
platformRouter.patch('/admin/notifications/:id/read', requireAdmin, async (req, res) => {
  await query('update admin_notifications set read_at=coalesce(read_at,now()) where id=$1',[req.params.id]);
  res.json({ ok: true });
});

platformRouter.get('/admin/players', requireAdmin, async (req, res) => {
  const { page, limit } = pageParams(req);
  const q = String(req.query.q || '').trim().slice(0,80);
  const status = ['active','suspended','blocked'].includes(req.query.status) ? req.query.status : '';
  const result = await query(`select u.id,u.email,u.status,u.suspended_until,u.email_verified_at,u.manual_verified_at,u.created_at,p.full_name,p.username,p.phone,p.age,p.bio,
    coalesce((select sum(points) from og_points_ledger l where l.user_id=u.id),0)::int og_points,
    (select count(*) from tournament_registrations r where r.player_id=u.id and r.status<>'cancelled')::int registration_count,
    (select count(*) from team_members tm where tm.user_id=u.id)::int team_count,count(*) over() total_count
    from users u join player_profiles p on p.user_id=u.id where u.role='player' and ($1='' or u.status=$1)
      and ($2='' or p.username ilike '%'||$2||'%' or p.full_name ilike '%'||$2||'%' or u.email ilike '%'||$2||'%')
    order by u.created_at desc limit $3 offset $4`,[status,q,limit,(page-1)*limit]);
  res.json({ data: result.rows, page, limit, total: Number(result.rows[0]?.total_count || 0) });
});
platformRouter.patch('/admin/players/:id/status', requireAdmin, async (req, res) => {
  const data = parse(z.object({ status: z.enum(['active','suspended','blocked']), suspendedUntil: z.string().datetime().optional() }), req.body);
  if (!data || !uuid.safeParse(req.params.id).success || (data.status==='suspended' && !data.suspendedUntil)) return res.status(400).json({ error: 'Provide a valid account status and suspension end time.' });
  const result = await withTransaction(async (client) => {
    const changed = await client.query("update users set status=$2,suspended_until=case when $2='suspended' then $3::timestamptz else null end,updated_at=now() where id=$1 and role='player' returning id,status,suspended_until", [req.params.id,data.status,data.suspendedUntil || null]);
    if (!changed.rowCount) return null;
    await recordAudit(client,userId(req),'account_status_changed','user',req.params.id,{status:data.status,suspendedUntil:data.suspendedUntil || null});
    await client.query('insert into notifications(user_id,kind,title,body) values($1,$2,$3,$4)', [req.params.id,'account_status','Account status updated',data.status==='active'?'Your account is active.':data.status==='blocked'?'Your account has been blocked.':`Your account is suspended until ${data.suspendedUntil}.`]);
    return changed.rows[0];
  });
  if (!result) return res.status(404).json({ error: 'Player not found.' });
  res.json({ player: result });
});
platformRouter.patch('/admin/players/:id/verification',requireAdmin,async(req,res)=>{
  const data=parse(z.object({verified:z.boolean()}),req.body);
  if(!data||!uuid.safeParse(req.params.id).success)return res.status(400).json({error:'Set a valid manual verification status.'});
  const result=await withTransaction(async(client)=>{
    const player=await client.query("update users set manual_verified_at=case when $2 then coalesce(manual_verified_at,now()) else null end,updated_at=now() where id=$1 and role='player' returning id,manual_verified_at",[req.params.id,data.verified]);
    if(!player.rowCount)return null;
    await recordAudit(client,userId(req),data.verified?'player_manually_verified':'player_manual_verification_removed','user',req.params.id);
    return player.rows[0];
  });
  if(!result)return res.status(404).json({error:'Player not found.'});
  res.json({player:result});
});

platformRouter.get('/admin/tournaments', requireAdmin, async (req, res) => {
  const result = await query(`select t.id,t.name,t.slug,t.description,t.rules,t.status,t.start_at,t.registration_opens_at,t.registration_deadline,t.visibility_deadline,t.visibility_mode,t.artwork_url,t.artwork_path,t.capacity,t.entry_fee_paise,t.reward_config,g.name game_name,f.name format_name,
    (select count(*) from tournament_registrations r where r.tournament_id=t.id and r.status='confirmed') registrations from tournaments t join games g on g.id=t.game_id join game_formats f on f.id=t.format_id order by t.created_at desc limit 100`);
  const data=await Promise.all(result.rows.map(async row=>({...row,artwork_url:row.artwork_path?await signedAssetUrl(row.artwork_path):row.artwork_url})));
  res.json({ data });
});
platformRouter.post('/admin/games',requireAdmin,async(req,res)=>{
  const data=parse(z.object({name:z.string().trim().min(2).max(70),slug:z.string().trim().min(2).max(80).regex(/^[a-z0-9-]+$/),description:z.string().max(500).optional(),formats:z.array(z.object({name:z.string().trim().min(2).max(40),participantCount:z.number().int().min(1).max(100)})).min(1).max(12)}),req.body);
  if(!data)return res.status(400).json({error:'Provide a game name and at least one format.'});
  const game=await withTransaction(async(client)=>{
    const created=await client.query('insert into games(name,slug,description) values($1,$2,$3) returning id,name,slug',[data.name,data.slug,data.description||'']);
    for(const format of data.formats)await client.query('insert into game_formats(game_id,name,participant_count) values($1,$2,$3)',[created.rows[0].id,format.name,format.participantCount]);
    await recordAudit(client,userId(req),'game_created','game',created.rows[0].id,{formatCount:data.formats.length});return created.rows[0];
  });res.status(201).json({game});
});
platformRouter.get('/admin/games',requireAdmin,async(req,res)=>{const result=await query(`select g.id,g.name,g.slug,g.description,g.active,coalesce(json_agg(json_build_object('id',f.id,'name',f.name,'participantCount',f.participant_count,'active',f.active)) filter(where f.id is not null),'[]') formats from games g left join game_formats f on f.game_id=g.id group by g.id order by g.name`);res.json({data:result.rows});});
platformRouter.put('/admin/games/:id',requireAdmin,async(req,res)=>{
  if(!uuid.safeParse(req.params.id).success)return res.status(400).json({error:'Choose a valid game.'});
  const formatSchema=z.object({id:z.string().uuid().optional(),name:z.string().trim().min(2).max(40),participantCount:z.number().int().min(1).max(100),active:z.boolean().default(true)});
  const data=parse(z.object({name:z.string().trim().min(2).max(70),slug:z.string().trim().min(2).max(80).regex(/^[a-z0-9-]+$/),description:z.string().max(500).optional(),active:z.boolean(),formats:z.array(formatSchema).min(1).max(12)}),req.body);
  if(!data)return res.status(400).json({error:'Provide a game name, slug, and at least one format.'});
  if(new Set(data.formats.map(format=>format.name.toLowerCase())).size!==data.formats.length)return res.status(400).json({error:'Format names must be unique within a game.'});
  const result=await withTransaction(async(client)=>{
    const current=await client.query('select id from games where id=$1 for update',[req.params.id]);
    if(!current.rowCount)return null;
    await client.query('update games set name=$2,slug=$3,description=$4,active=$5,updated_at=now() where id=$1',[req.params.id,data.name,data.slug,data.description||'',data.active]);
    const retained=[];
    for(const format of data.formats){
      if(format.id){
        const updated=await client.query('update game_formats set name=$3,participant_count=$4,active=$5 where id=$1 and game_id=$2 returning id',[format.id,req.params.id,format.name,format.participantCount,format.active]);
        if(!updated.rowCount)return {error:'A selected format does not belong to this game.'};
        retained.push(format.id);
      }else{
        const inserted=await client.query('insert into game_formats(game_id,name,participant_count,active) values($1,$2,$3,$4) returning id',[req.params.id,format.name,format.participantCount,format.active]);
        retained.push(inserted.rows[0].id);
      }
    }
    await client.query('update game_formats set active=false where game_id=$1 and not(id=any($2::uuid[]))',[req.params.id,retained]);
    await recordAudit(client,userId(req),'game_updated','game',req.params.id,{active:data.active,formatCount:data.formats.length});
    return {ok:true};
  });
  if(!result)return res.status(404).json({error:'Game not found.'});
  if(result.error)return res.status(400).json({error:result.error});
  res.json(result);
});
platformRouter.delete('/admin/games/:id',requireAdmin,async(req,res)=>{
  if(!uuid.safeParse(req.params.id).success)return res.status(400).json({error:'Choose a valid game.'});
  const result=await withTransaction(async(client)=>{
    const archived=await client.query('update games set active=false,updated_at=now() where id=$1 returning id',[req.params.id]);
    if(!archived.rowCount)return null;
    await recordAudit(client,userId(req),'game_archived','game',req.params.id);
    return {ok:true};
  });
  if(!result)return res.status(404).json({error:'Game not found.'});
  res.json(result);
});

platformRouter.get('/admin/teams',requireAdmin,async(req,res)=>{
  const result=await query(`select t.id,t.name,t.active,g.name game_name,f.name format_name,p.username leader,
    coalesce(json_agg(json_build_object('userId',tm.user_id,'username',mp.username,'role',tm.role) order by tm.joined_at) filter(where tm.user_id is not null),'[]') roster,
    (select count(*) from tournament_registrations r where r.team_id=t.id)::int registrations
    from teams t join games g on g.id=t.game_id join game_formats f on f.id=t.format_id left join player_profiles p on p.user_id=t.leader_user_id left join team_members tm on tm.team_id=t.id left join player_profiles mp on mp.user_id=tm.user_id group by t.id,g.name,f.name,p.username,t.created_at order by t.created_at desc limit 200`);res.json({data:result.rows});
});
platformRouter.patch('/admin/teams/:id/leader',requireAdmin,async(req,res)=>{
  const data=parse(z.object({userId:z.string().uuid()}),req.body);if(!data)return res.status(400).json({error:'Choose a valid team member.'});
  const result=await withTransaction(async(client)=>{const team=await client.query('select id from teams where id=$1 for update',[req.params.id]);if(!team.rowCount)return null;const member=await client.query('select 1 from team_members where team_id=$1 and user_id=$2',[req.params.id,data.userId]);if(!member.rowCount)return {error:'The team leader must be a roster member.'};await client.query("update team_members set role='member' where team_id=$1",[req.params.id]);await client.query("update team_members set role='leader' where team_id=$1 and user_id=$2",[req.params.id,data.userId]);await client.query('update teams set leader_user_id=$2,updated_at=now() where id=$1',[req.params.id,data.userId]);await recordAudit(client,userId(req),'team_leader_changed','team',req.params.id,{userId:data.userId});return {ok:true};});
  if(!result)return res.status(404).json({error:'Team not found.'});if(result.error)return res.status(400).json({error:result.error});res.json(result);
});

platformRouter.get('/admin/matches',requireAdmin,async(req,res)=>{
  const result=await query(`select m.id,m.tournament_id,m.title,m.status,m.scheduled_at,m.room_id,m.room_password,m.room_releases_at,t.name tournament_name,
    (select count(*) from match_participants mp where mp.match_id=m.id)::int participant_count,
    (select coalesce(array_agg(mp.registration_id),'{}'::uuid[]) from match_participants mp where mp.match_id=m.id) participant_ids,
    (select count(*) from match_results mr where mr.match_id=m.id and not exists(select 1 from match_results newer where newer.correction_of=mr.id))::int result_count
    from matches m join tournaments t on t.id=m.tournament_id order by m.scheduled_at desc limit 200`);res.json({data:result.rows});
});
platformRouter.get('/admin/matches/:id/results',requireAdmin,async(req,res)=>{
  const [result,rewards]=await Promise.all([query(`select mp.registration_id,mr.placement,mr.og_points,mr.xp_points,mr.cash_paise,r.reference,r.registration_number,p.username,team.name team_name
    from match_participants mp join tournament_registrations r on r.id=mp.registration_id
    left join player_profiles p on p.user_id=r.player_id left join teams team on team.id=r.team_id
    left join lateral(select current.placement,coalesce(rt.og_points,0)::int og_points,coalesce(rt.xp_points,0)::int xp_points,coalesce(rt.cash_paise,0)::bigint cash_paise from match_results current left join reward_transactions rt on rt.result_id=current.id and rt.status='confirmed' where current.match_id=mp.match_id and current.registration_id=mp.registration_id
      and not exists(select 1 from match_results newer where newer.correction_of=current.id) order by current.created_at desc,current.id desc limit 1) mr on true
    where mp.match_id=$1 order by mr.placement nulls last,r.reference`,[req.params.id]),query(`select rr.placement,rr.cash_paise,rr.og_points,rr.xp_points from reward_rules rr join matches m on m.tournament_id=rr.tournament_id where m.id=$1 order by rr.placement`,[req.params.id])]);
  res.json({data:result.rows,rewardRules:rewards.rows});
});
platformRouter.patch('/admin/matches/:id',requireAdmin,async(req,res)=>{
  const data=parse(z.object({title:z.string().trim().min(2).max(100).optional(),scheduledAt:z.string().datetime().optional(),status:z.enum(['scheduled','ongoing','completed','cancelled']).optional(),roomId:z.string().max(100).nullable().optional(),roomPassword:z.string().max(100).nullable().optional(),roomReleasesAt:z.string().datetime().nullable().optional()}),req.body);if(!data)return res.status(400).json({error:'Check match update fields.'});
  if(data.status==='completed')return res.status(409).json({error:'Publish match results to complete a match and award its OG Points and XP.'});
  const result=await withTransaction(async(client)=>{const current=await client.query('select status from matches where id=$1 for update',[req.params.id]);if(!current.rowCount)return null;if(current.rows[0].status==='completed')return {error:'Published results are locked. Use the audited result correction workflow.'};const row=await client.query(`update matches set title=coalesce($2,title),scheduled_at=coalesce($3,scheduled_at),status=coalesce($4,status),room_id=case when $5 then $6 else room_id end,room_password=case when $7 then $8 else room_password end,room_releases_at=case when $9 then $10::timestamptz else room_releases_at end,updated_at=now() where id=$1 returning id,title,status,scheduled_at`,[req.params.id,data.title||null,data.scheduledAt||null,data.status||null,Object.hasOwn(data,'roomId'),data.roomId||null,Object.hasOwn(data,'roomPassword'),data.roomPassword||null,Object.hasOwn(data,'roomReleasesAt'),data.roomReleasesAt||null]);await recordAudit(client,userId(req),'match_updated','match',req.params.id,{status:data.status});return row.rows[0];});if(!result)return res.status(404).json({error:'Match not found.'});if(result.error)return res.status(409).json({error:result.error});res.json({match:result});
});

platformRouter.get('/admin/support',requireAdmin,async(req,res)=>{
  const result=await query(`select t.id,t.category,t.subject,t.status,t.created_at,p.username,u.email,
    coalesce(json_agg(json_build_object('id',m.id,'message',m.message,'senderRole',m.sender_role,'createdAt',m.created_at) order by m.created_at) filter(where m.id is not null),'[]') messages
    from support_tickets t join users u on u.id=t.user_id join player_profiles p on p.user_id=u.id left join support_messages m on m.ticket_id=t.id group by t.id,p.username,u.email order by t.updated_at desc limit 100`);res.json({data:result.rows});
});
platformRouter.patch('/admin/support/:id',requireAdmin,async(req,res)=>{
  const data=parse(z.object({status:z.enum(['open','in_progress','resolved','closed']),reply:z.string().trim().min(1).max(4000).optional()}),req.body);if(!data)return res.status(400).json({error:'Check ticket update.'});
  const result=await withTransaction(async(client)=>{const ticket=await client.query('update support_tickets set status=$2,updated_at=now() where id=$1 returning user_id',[req.params.id,data.status]);if(!ticket.rowCount)return null;if(data.reply){await client.query("insert into support_messages(ticket_id,sender_id,sender_role,message) values($1,$2,'admin',$3)",[req.params.id,userId(req),data.reply]);await client.query(`insert into notifications(user_id,kind,title,body,href) values($1,'support_reply','Support replied',$2,'/support')`,[ticket.rows[0].user_id,'There is a new reply on your support request.']);}await recordAudit(client,userId(req),'support_ticket_updated','ticket',req.params.id,{status:data.status});return {ok:true};});if(!result)return res.status(404).json({error:'Ticket not found.'});res.json(result);
});

platformRouter.post('/admin/announcements',requireAdmin,async(req,res)=>{
  const data=parse(z.object({title:z.string().trim().min(2).max(120),body:z.string().trim().min(2).max(4000),active:z.boolean().optional()}),req.body);if(!data)return res.status(400).json({error:'Check announcement details.'});
  const result=await withTransaction(async(client)=>{const a=await client.query('insert into site_announcements(title,body,active,published_at) values($1,$2,$3,case when $3 then now() else null end) returning *',[data.title,data.body,data.active??true]);if(data.active!==false)await client.query(`insert into notifications(user_id,kind,title,body) select id,'announcement',$1,$2 from users where role='player' and status='active'`,[data.title,data.body]);await recordAudit(client,userId(req),'announcement_created','announcement',a.rows[0].id);return a.rows[0];});res.status(201).json({announcement:result});
});
platformRouter.get('/admin/announcements',requireAdmin,async(req,res)=>{const result=await query('select * from site_announcements order by created_at desc limit 100');res.json({data:result.rows});});
platformRouter.patch('/admin/announcements/:id',requireAdmin,async(req,res)=>{const data=parse(z.object({active:z.boolean()}),req.body);if(!data)return res.status(400).json({error:'Set announcement visibility.'});const result=await query('update site_announcements set active=$2,published_at=case when $2 then coalesce(published_at,now()) else published_at end where id=$1 returning *',[req.params.id,data.active]);if(!result.rowCount)return res.status(404).json({error:'Announcement not found.'});res.json({announcement:result.rows[0]});});
platformRouter.post('/admin/tournaments', requireAdmin, uploadImage.single('thumbnail'), async (req, res) => {
  let rankRewards=req.body.rankRewards;
  if(typeof rankRewards==='string'){try{rankRewards=JSON.parse(rankRewards);}catch{return res.status(400).json({error:'Check prize pool ranks.'});}}
  const rewardSchema=z.array(z.object({place:z.number().int().min(0).max(20),cashPaise:z.number().int().nonnegative().max(100000000),ogPoints:z.number().int().nonnegative().max(100000000),xpPoints:z.number().int().nonnegative().max(100000000)})).max(21).refine(rows=>new Set(rows.map(row=>row.place)).size===rows.length,'Prize places must be unique.').refine(rows=>rows.some(row=>row.place===0),'Set a shared Every contender reward.');
  const rewardCheck=rewardSchema.safeParse(rankRewards??[]);if(!rewardCheck.success)return res.status(400).json({error:'Prize ranks must be unique and use valid non-negative reward values.'});
  const checked = z.object({ gameId:z.string().uuid(),formatId:z.string().uuid(),name:z.string().trim().min(3).max(100),slug:z.string().trim().min(3).max(120).regex(/^[a-z0-9-]+$/),description:z.string().max(5000).optional(),rules:z.string().max(12000).optional(),startAt:z.string().datetime(),registrationOpensAt:z.string().datetime().optional(),registrationDeadline:z.string().datetime(),visibilityDeadline:z.string().datetime().optional(),visibilityMode:z.enum(['auto','show','hide']).default('auto'),timezone:z.string().min(3).max(60).optional(),capacity:z.preprocess(value=>value===''?null:value,z.coerce.number().int().positive().nullable().optional()),entryFeePaise:z.coerce.number().int().nonnegative().max(100000000),cashPrizePaise:z.coerce.number().int().nonnegative().max(100000000).default(0),ogPointsPrize:z.coerce.number().int().nonnegative().max(100000000).default(0),xpPointsPrize:z.coerce.number().int().nonnegative().max(100000000).default(0),artworkUrl:z.string().url().optional().or(z.literal('')),prizes:z.array(z.object({place:z.string().max(40),description:z.string().max(300)})).max(10).optional(),status:z.enum(['draft','published']).default('published') }).safeParse(req.body);
  if (!checked.success) return res.status(400).json({error:'Check the game, format, tournament name, registration window, tournament deadline, and entry fee.'});
  const data=checked.data;const now=new Date();const registrationOpensAt=data.registrationOpensAt||now.toISOString();const visibilityDeadline=data.visibilityDeadline||data.startAt;
  if(new Date(registrationOpensAt)>new Date(data.registrationDeadline)||new Date(data.registrationDeadline)>new Date(data.startAt)||new Date(visibilityDeadline)<new Date(data.startAt))return res.status(400).json({error:'Set dates in order: registration opens, registration closes, tournament starts, then the auto-hide deadline.'});
  const file=req.file,detected=file&&imageType(file.buffer);if(file&&(!detected||file.mimetype!==detected.mime))return res.status(400).json({error:'Choose a PNG, JPEG, or WebP tournament thumbnail.'});
  const artworkPath=file?`tournaments/${randomUUID()}.${detected.ext}`:null;let uploaded=false;
  try{
    if(file){await uploadProfileAsset(artworkPath,file.buffer,detected.mime);uploaded=true;}
    const result=await withTransaction(async(client)=>{
      const format=await client.query('select f.id from game_formats f join games g on g.id=f.game_id where f.id=$1 and f.game_id=$2 and f.active=true and g.active=true',[data.formatId,data.gameId]);
      if(!format.rowCount)return null;
      const configuredRewards=rewardCheck.data;
      const rewardConfig={cashPaise:configuredRewards.length?configuredRewards.reduce((sum,row)=>sum+row.cashPaise,0):data.cashPrizePaise,ogPoints:configuredRewards.length?configuredRewards.reduce((sum,row)=>sum+row.ogPoints,0):data.ogPointsPrize,xpPoints:configuredRewards.length?configuredRewards.reduce((sum,row)=>sum+row.xpPoints,0):data.xpPointsPrize,rankRewards:configuredRewards};
      const created=await client.query(`insert into tournaments(game_id,format_id,name,slug,description,rules,start_at,registration_opens_at,registration_deadline,visibility_deadline,visibility_mode,timezone,capacity,entry_fee_paise,artwork_url,artwork_path,prizes,reward_config,status,published_at)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17::jsonb,$18::jsonb,$19,case when $19='published' then now() else null end) returning id,name,status,registration_opens_at,registration_deadline,visibility_deadline,visibility_mode,artwork_path,reward_config`,[data.gameId,data.formatId,data.name,data.slug,data.description||'',data.rules||'',data.startAt,registrationOpensAt,data.registrationDeadline,visibilityDeadline,data.visibilityMode,data.timezone||'Asia/Kolkata',data.capacity??null,data.entryFeePaise,data.artworkUrl||null,artworkPath,JSON.stringify(data.prizes||[]),JSON.stringify(rewardConfig),data.status]);
      for(const reward of configuredRewards)await client.query('insert into reward_rules(tournament_id,placement,og_points,xp_points,cash_paise) values($1,$2,$3,$4,$5) on conflict(tournament_id,placement) do update set og_points=excluded.og_points,xp_points=excluded.xp_points,cash_paise=excluded.cash_paise',[created.rows[0].id,reward.place,reward.ogPoints,reward.xpPoints,reward.cashPaise]);
      await recordAudit(client,userId(req),'tournament_created','tournament',created.rows[0].id,{status:data.status,visibilityMode:data.visibilityMode,rewardConfig});
      return created.rows[0];
    });
    if(!result){if(uploaded)await removeProfileAsset(artworkPath);return res.status(400).json({error:'The selected game or format is no longer active. Refresh and choose an active format.'});}
    res.status(201).json({tournament:{...result,artwork_url:artworkPath?await signedAssetUrl(artworkPath):data.artworkUrl||''}});
  }catch(error){if(uploaded)try{await removeProfileAsset(artworkPath);}catch{}throw error;}
});
platformRouter.patch('/admin/tournaments/:id/visibility',requireAdmin,async(req,res)=>{
  const data=parse(z.object({visibilityMode:z.enum(['auto','show','hide'])}),req.body);
  if(!data||!uuid.safeParse(req.params.id).success)return res.status(400).json({error:'Choose Auto, Show, or Hide visibility.'});
  const result=await withTransaction(async(client)=>{const row=await client.query("update tournaments set visibility_mode=$2,updated_at=now() where id=$1 and status<>'archived' returning id,name,visibility_mode",[req.params.id,data.visibilityMode]);if(!row.rowCount)return null;await recordAudit(client,userId(req),'tournament_visibility_updated','tournament',req.params.id,{visibilityMode:data.visibilityMode});return row.rows[0];});
  if(!result)return res.status(404).json({error:'Tournament not found or archived.'});res.json({tournament:result});
});
platformRouter.patch('/admin/tournaments/:id/complete',requireAdmin,async(req,res)=>{
  if(!uuid.safeParse(req.params.id).success)return res.status(400).json({error:'Choose a valid tournament.'});
  const result=await withTransaction(async(client)=>{const row=await client.query("update tournaments set status='completed',updated_at=now() where id=$1 and status not in ('archived','cancelled','completed') returning id,name,status",[req.params.id]);if(!row.rowCount)return null;await recordAudit(client,userId(req),'tournament_marked_completed','tournament',req.params.id,{forTesting:true});return row.rows[0];});
  if(!result)return res.status(404).json({error:'Tournament not found or it is already closed.'});res.json({tournament:result});
});
platformRouter.put('/admin/tournaments/:id', requireAdmin, async (req, res) => {
  const rewardSchema=z.array(z.object({place:z.number().int().min(0).max(20),cashPaise:z.number().int().nonnegative().max(100000000),ogPoints:z.number().int().nonnegative().max(100000000),xpPoints:z.number().int().nonnegative().max(100000000)})).max(21).refine(rows=>new Set(rows.map(row=>row.place)).size===rows.length).refine(rows=>rows.some(row=>row.place===0),'Set a shared Every contender reward.');
  const data = parse(z.object({ name:z.string().trim().min(3).max(100),description:z.string().max(5000),rules:z.string().max(12000),startAt:z.string().datetime(),registrationDeadline:z.string().datetime(),capacity:z.coerce.number().int().positive().nullable(),entryFeePaise:z.coerce.number().int().nonnegative().max(100000000),cashPrizePaise:z.coerce.number().int().nonnegative().max(100000000).default(0),ogPointsPrize:z.coerce.number().int().nonnegative().max(100000000).default(0),xpPointsPrize:z.coerce.number().int().nonnegative().max(100000000).default(0),rankRewards:rewardSchema.optional(),status:z.enum(['draft','published','registration_closed','ongoing','completed','cancelled','archived']) }),req.body);
  if(!data||new Date(data.registrationDeadline)>new Date(data.startAt))return res.status(400).json({error:'Check tournament settings and dates.'});
  const result=await withTransaction(async(client)=>{
    const rankRewards=data.rankRewards||[];
    const rewardConfig={cashPaise:rankRewards.length?rankRewards.reduce((sum,row)=>sum+row.cashPaise,0):data.cashPrizePaise,ogPoints:rankRewards.length?rankRewards.reduce((sum,row)=>sum+row.ogPoints,0):data.ogPointsPrize,xpPoints:rankRewards.length?rankRewards.reduce((sum,row)=>sum+row.xpPoints,0):data.xpPointsPrize,rankRewards};
    const row=await client.query(`update tournaments set name=$2,description=$3,rules=$4,start_at=$5,registration_deadline=$6,capacity=$7,entry_fee_paise=$8,reward_config=$9::jsonb,status=$10,published_at=case when $10='published' then coalesce(published_at,now()) else published_at end,updated_at=now() where id=$1 returning id,name,status,reward_config`,[req.params.id,data.name,data.description,data.rules,data.startAt,data.registrationDeadline,data.capacity,data.entryFeePaise,JSON.stringify(rewardConfig),data.status]);
    if(!row.rowCount)return null;
    if(data.rankRewards){for(const reward of rankRewards)await client.query('insert into reward_rules(tournament_id,placement,og_points,xp_points,cash_paise) values($1,$2,$3,$4,$5) on conflict(tournament_id,placement) do update set og_points=excluded.og_points,xp_points=excluded.xp_points,cash_paise=excluded.cash_paise',[req.params.id,reward.place,reward.ogPoints,reward.xpPoints,reward.cashPaise]);await client.query('delete from reward_rules where tournament_id=$1 and not (placement=any($2::int[]))',[req.params.id,rankRewards.map(reward=>reward.place)]);}
    await recordAudit(client,userId(req),'tournament_updated','tournament',req.params.id,{status:data.status,rewardConfig});
    return row.rows[0];
  });
  if(!result)return res.status(404).json({error:'Tournament not found.'});
  res.json({tournament:result});
});
platformRouter.delete('/admin/tournaments/:id', requireAdmin, async (req, res) => {
  if(!uuid.safeParse(req.params.id).success)return res.status(400).json({error:'Choose a valid tournament.'});
  const result=await withTransaction(async(client)=>{
    const archived=await client.query("update tournaments set status='archived',updated_at=now() where id=$1 and status<>'archived' returning id,name",[req.params.id]);
    if(!archived.rowCount)return null;
    await recordAudit(client,userId(req),'tournament_archived','tournament',req.params.id);
    return archived.rows[0];
  });
  if(!result)return res.status(404).json({error:'Tournament not found or already archived.'});
  res.json({tournament:result});
});

platformRouter.delete('/admin/tournaments/:id/artwork',requireAdmin,async(req,res)=>{
  if(!uuid.safeParse(req.params.id).success)return res.status(400).json({error:'Choose a valid tournament.'});
  const result=await withTransaction(async(client)=>{
    const row=await client.query('select id,artwork_path,artwork_url from tournaments where id=$1 for update',[req.params.id]);
    if(!row.rowCount)return null;
    if(!row.rows[0].artwork_path&&!row.rows[0].artwork_url)return {empty:true};
    await client.query('update tournaments set artwork_path=null,artwork_url=null,updated_at=now() where id=$1',[req.params.id]);
    await recordAudit(client,userId(req),'tournament_artwork_removed','tournament',req.params.id);
    return {path:row.rows[0].artwork_path};
  });
  if(!result)return res.status(404).json({error:'Tournament not found.'});
  if(result.path)await removeProfileAsset(result.path);
  res.json({ok:true,alreadyRemoved:Boolean(result.empty)});
});

platformRouter.delete('/admin/tournaments/:id/permanent',requireAdmin,async(req,res)=>{
  if(!uuid.safeParse(req.params.id).success)return res.status(400).json({error:'Choose a valid tournament.'});
  const result=await withTransaction(async(client)=>{
    const row=await client.query('select id,name,artwork_path from tournaments where id=$1 for update',[req.params.id]);
    if(!row.rowCount)return null;
    const dependencies=await client.query(`select
      exists(select 1 from tournament_registrations where tournament_id=$1) registrations,
      exists(select 1 from matches where tournament_id=$1) matches`,[req.params.id]);
    if(dependencies.rows[0].registrations||dependencies.rows[0].matches)return {error:'This tournament has registration or match history. Archive it to keep those records safe.'};
    await recordAudit(client,userId(req),'tournament_deleted','tournament',req.params.id,{name:row.rows[0].name});
    await client.query('delete from tournaments where id=$1',[req.params.id]);
    return {name:row.rows[0].name,path:row.rows[0].artwork_path};
  });
  if(!result)return res.status(404).json({error:'Tournament not found.'});
  if(result.error)return res.status(409).json({error:result.error});
  if(result.path)await removeProfileAsset(result.path);
  res.json({deleted:true,name:result.name});
});

platformRouter.get('/admin/registrations', requireAdmin, async (req, res) => {
  const {page,limit}=pageParams(req); const q=String(req.query.q||'').trim().slice(0,80);
  const tournamentId=uuid.safeParse(req.query.tournamentId).success?req.query.tournamentId:'';
  const result=await query(`select r.id,r.registration_number,r.reference,r.status,r.payment_status,r.created_at,t.name tournament_name,g.name game_name,p.username,team.name team_name,coalesce(p.upi_id,leader.upi_id) payment_upi_id,t.id tournament_id,count(*) over() total_count
    from tournament_registrations r join tournaments t on t.id=r.tournament_id join games g on g.id=t.game_id left join player_profiles p on p.user_id=r.player_id left join teams team on team.id=r.team_id left join player_profiles leader on leader.user_id=team.leader_user_id
    where ($1='' or r.reference ilike '%'||$1||'%' or r.registration_number::text ilike '%'||$1||'%' or p.username ilike '%'||$1||'%' or team.name ilike '%'||$1||'%') and ($4='' or t.id=$4::uuid) order by r.registration_number desc limit $2 offset $3`,[q,limit,(page-1)*limit,tournamentId]);
  res.json({data:result.rows,page,limit,total:Number(result.rows[0]?.total_count||0)});
});
platformRouter.delete('/admin/registrations/:id',requireAdmin,async(req,res)=>{
  if(!uuid.safeParse(req.params.id).success)return res.status(400).json({error:'Choose a valid registration.'});
  const result=await withTransaction(async(client)=>{
    const registration=await client.query('select id,registration_number,payment_status from tournament_registrations where id=$1 for update',[req.params.id]);
    if(!registration.rowCount)return null;
    const dependencies=await client.query(`select
      exists(select 1 from payments where registration_id=$1) payments,
      exists(select 1 from match_participants where registration_id=$1) matches,
      exists(select 1 from match_results where registration_id=$1) results`,[req.params.id]);
    const linked=dependencies.rows[0];
    if(linked.payments||linked.matches||linked.results||['paid','refunded'].includes(registration.rows[0].payment_status))return {error:'This registration has payment or match history and cannot be deleted. Keep it for the audit trail.'};
    await recordAudit(client,userId(req),'registration_deleted','registration',req.params.id,{registrationNumber:registration.rows[0].registration_number});
    await client.query('delete from tournament_registrations where id=$1',[req.params.id]);
    return {registrationNumber:registration.rows[0].registration_number};
  });
  if(!result)return res.status(404).json({error:'Registration not found.'});
  if(result.error)return res.status(409).json({error:result.error});
  res.json({deleted:true,registrationNumber:result.registrationNumber});
});
platformRouter.post('/admin/registrations/:id/participants',requireAdmin,async(req,res)=>{
  const schema=z.discriminatedUnion('method',[
    z.object({method:z.literal('account'),username:z.string().trim().min(3).max(24)}),
    z.object({method:z.literal('external'),name:z.string().trim().min(2).max(80),handle:z.string().trim().max(80).optional()}),
  ]);const data=parse(schema,req.body);if(!data)return res.status(400).json({error:'Provide a registered username or external participant name.'});
  const result=await withTransaction(async(client)=>{const registration=await client.query(`select r.id,r.team_id,r.tournament_id,f.participant_count from tournament_registrations r join tournaments t on t.id=r.tournament_id join game_formats f on f.id=t.format_id where r.id=$1 for update`,[req.params.id]);if(!registration.rowCount)return {error:'Registration not found.'};if(!registration.rows[0].team_id)return {error:'Manual roster entries are only available for team registrations.'};const count=await client.query('select count(*)::int n from registration_participants where registration_id=$1',[req.params.id]);if(Number(count.rows[0].n)>=Number(registration.rows[0].participant_count))return {error:'The registered roster already meets its configured size.'};let inserted;if(data.method==='account'){const player=await client.query("select u.id from users u join player_profiles p on p.user_id=u.id where lower(p.username)=lower($1) and u.role='player' and u.status='active'",[data.username]);if(!player.rowCount)return {error:'No eligible registered player was found.'};const duplicate=await client.query('select 1 from registration_participants where registration_id=$1 and user_id=$2',[req.params.id,player.rows[0].id]);if(duplicate.rowCount)return {error:'That player is already included.'};inserted=await client.query('insert into registration_participants(registration_id,user_id) values($1,$2) returning id',[req.params.id,player.rows[0].id]);}else{const duplicate=await client.query('select 1 from registration_participants where registration_id=$1 and (lower(external_name)=lower($2) or ($3 is not null and lower(external_handle)=lower($3)))',[req.params.id,data.name,data.handle||null]);if(duplicate.rowCount)return {error:'That external participant is already included.'};inserted=await client.query('insert into registration_participants(registration_id,external_name,external_handle) values($1,$2,$3) returning id',[req.params.id,data.name,data.handle||null]);}await recordAudit(client,userId(req),'registration_participant_added','registration',req.params.id,{method:data.method});return {participantId:inserted.rows[0].id};});if(result.error)return res.status(400).json({error:result.error});res.status(201).json(result);
});

platformRouter.post('/admin/matches', requireAdmin, async (req, res) => {
  const data=parse(z.object({tournamentId:z.string().uuid(),title:z.string().trim().min(2).max(100),scheduledAt:z.string().datetime(),registrationIds:z.array(z.string().uuid()).min(1).max(64),roomId:z.string().max(100).optional(),roomPassword:z.string().max(100).optional(),roomReleasesAt:z.string().datetime().optional(),rewardRules:z.array(z.object({placement:z.number().int().min(0),ogPoints:z.number().int().nonnegative(),xpPoints:z.number().int().nonnegative(),cashPaise:z.number().int().nonnegative()})).optional()}),req.body);
  if(!data)return res.status(400).json({error:'Check the match details.'});
  const match=await withTransaction(async(client)=>{
    const tournament=await client.query("select id from tournaments where id=$1 and status not in ('cancelled','archived')",[data.tournamentId]);
    if(!tournament.rowCount)return null;
    const regs=await client.query(`select id from tournament_registrations where id=any($1::uuid[]) and tournament_id=$2 and status='confirmed'`,[data.registrationIds,data.tournamentId]);
    if(regs.rowCount!==new Set(data.registrationIds).size)return {error:'Every match participant must be a confirmed entry in this tournament.'};
    const created=await client.query(`insert into matches(tournament_id,title,scheduled_at,room_id,room_password,room_releases_at) values($1,$2,$3,$4,$5,$6) returning id,title,status,scheduled_at`,[data.tournamentId,data.title,data.scheduledAt,data.roomId||null,data.roomPassword||null,data.roomReleasesAt||null]);
    for(const registrationId of data.registrationIds)await client.query('insert into match_participants(match_id,registration_id) values($1,$2)',[created.rows[0].id,registrationId]);
    for(const rule of data.rewardRules||[])await client.query('insert into reward_rules(tournament_id,placement,og_points,xp_points,cash_paise) values($1,$2,$3,$4,$5) on conflict(tournament_id,placement) do update set og_points=excluded.og_points,xp_points=excluded.xp_points,cash_paise=excluded.cash_paise',[data.tournamentId,rule.placement,rule.ogPoints,rule.xpPoints,rule.cashPaise]);
    await recordAudit(client,userId(req),'match_scheduled','match',created.rows[0].id);
    return created.rows[0];
  });
  if(!match)return res.status(404).json({error:'Tournament not found.'});
  if(match.error)return res.status(400).json({error:match.error});
  res.status(201).json({match});
});

platformRouter.post('/admin/matches/:id/finalize', requireAdmin, async (req, res) => {
  const data=parse(z.object({placements:z.array(z.object({registrationId:z.string().uuid(),placement:z.number().int().min(0)})).min(1).max(64),rewardRules:z.array(z.object({placement:z.number().int().min(0),ogPoints:z.number().int().nonnegative(),xpPoints:z.number().int().nonnegative(),cashPaise:z.number().int().nonnegative().max(100000000).optional().default(0)})).max(64).optional()}),req.body);
  if(!data)return res.status(400).json({error:'Provide valid result placements.'});
  const finalized=await withTransaction(async(client)=>{
    const match=await client.query("select m.id,m.tournament_id,m.status from matches m where m.id=$1 for update",[req.params.id]);
    if(!match.rowCount)return {error:'Match not found.',status:404};
    if(match.rows[0].status==='completed')return {error:'This result is already finalized. Use an audited result correction workflow.',status:409};
    const participants=await client.query('select registration_id from match_participants where match_id=$1',[req.params.id]);
    const placementIds=data.placements.map(x=>x.registrationId);
    if(new Set(placementIds).size!==placementIds.length||participants.rowCount!==placementIds.length||participants.rows.some(x=>!placementIds.includes(x.registration_id)))return {error:'Enter one placement for every match participant, without duplicates.',status:400};
    const rewardPlacements=new Set();
    for(const rule of data.rewardRules||[]){if(rewardPlacements.has(rule.placement))return {error:'Each placement reward can only be entered once.',status:400};rewardPlacements.add(rule.placement);await client.query(`insert into reward_rules(tournament_id,placement,og_points,xp_points,cash_paise) values($1,$2,$3,$4,$5)
      on conflict(tournament_id,placement) do update set og_points=excluded.og_points,xp_points=excluded.xp_points,cash_paise=excluded.cash_paise`,[match.rows[0].tournament_id,rule.placement,rule.ogPoints,rule.xpPoints,rule.cashPaise]);}
    const created=[];
    for(const entry of data.placements){
      const result=await client.query('insert into match_results(match_id,registration_id,placement,finalized_by,finalized_at) values($1,$2,$3,$4,now()) returning id',[req.params.id,entry.registrationId,entry.placement,userId(req)]);
      const rule=await client.query('select og_points,xp_points,cash_paise from reward_rules where tournament_id=$1 and placement in ($2,0) order by (placement=$2) desc limit 1',[match.rows[0].tournament_id,entry.placement]);
      const reward=rule.rows[0]||{og_points:0,xp_points:0,cash_paise:0};
      const registration=await client.query('select player_id,team_id from tournament_registrations where id=$1',[entry.registrationId]);
      const recipient=registration.rows[0];
      const transaction=await client.query('insert into reward_transactions(result_id,user_id,team_id,og_points,xp_points,cash_paise,status) values($1,$2,$3,$4,$5,$6,\'confirmed\') returning id',[result.rows[0].id,recipient.player_id,recipient.team_id,reward.og_points,reward.xp_points,reward.cash_paise]);
      let members=[];
      if(recipient.team_id){
        const team=await client.query('select user_id from team_members where team_id=$1 order by joined_at',[recipient.team_id]); members=team.rows;
        await client.query('insert into og_points_ledger(team_id,result_id,points,reason,idempotency_key,created_by) values($1,$2,$3,$4,$5,$6)',[recipient.team_id,result.rows[0].id,reward.og_points,`Match placement ${entry.placement}`,`${result.rows[0].id}:team`,userId(req)]);
      }else members=[{user_id:recipient.player_id}];
      for(const member of members){
        await client.query('insert into og_points_ledger(user_id,result_id,points,reason,idempotency_key,created_by) values($1,$2,$3,$4,$5,$6)',[member.user_id,result.rows[0].id,reward.og_points,`Match placement ${entry.placement}`,`${result.rows[0].id}:${member.user_id}`,userId(req)]);
        if(Number(reward.xp_points)>0)await client.query('insert into xp_points_ledger(user_id,points,reason,idempotency_key) values($1,$2,$3,$4)',[member.user_id,reward.xp_points,`Match placement ${entry.placement}`,`${result.rows[0].id}:${member.user_id}`]);
        await client.query(`insert into notifications(user_id,kind,title,body,href) values($1,'match_result','Match results published',$2,'/rewards')`,[member.user_id,`You placed ${entry.placement}. OG Points and XP have been recorded.`]);
      }
      if(Number(reward.cash_paise)>0)await client.query('insert into cash_reward_records(reward_transaction_id,user_id,team_id,amount_paise,status) values($1,$2,$3,$4,\'confirmed\')',[transaction.rows[0].id,recipient.player_id,recipient.team_id,reward.cash_paise]);
      created.push(result.rows[0].id);
    }
    await client.query("update matches set status='completed',updated_at=now() where id=$1",[req.params.id]);
    await recordAudit(client,userId(req),'match_results_finalized','match',req.params.id,{resultIds:created});
    return {resultIds:created};
  });
  if(finalized.error)return res.status(finalized.status).json({error:finalized.error});
  res.json({finalized:true,...finalized});
});

platformRouter.post('/admin/matches/:id/corrections',requireAdmin,async(req,res)=>{
  const data=parse(z.object({reason:z.string().trim().min(8).max(1000),placements:z.array(z.object({registrationId:z.string().uuid(),placement:z.number().int().min(0)})).min(1).max(64)}),req.body);
  if(!data)return res.status(400).json({error:'Provide an audit reason and valid result placements.'});
  const corrected=await withTransaction(async(client)=>{
    const match=await client.query("select id,tournament_id,status from matches where id=$1 for update",[req.params.id]);
    if(!match.rowCount)return {error:'Match not found.',status:404};
    if(match.rows[0].status!=='completed')return {error:'Only finalized match results can be corrected.',status:409};
    const participants=await client.query('select registration_id from match_participants where match_id=$1 order by registration_id',[req.params.id]);
    const requested=data.placements.map(x=>x.registrationId);
    if(requested.length!==participants.rowCount||new Set(requested).size!==requested.length||participants.rows.some(x=>!requested.includes(x.registration_id)))return {error:'A correction must include exactly one placement for every match participant.',status:400};
    const prior=await client.query(`select distinct on(registration_id) id,registration_id,placement from match_results where match_id=$1 order by registration_id,created_at desc,id desc`,[req.params.id]);
    if(prior.rowCount!==participants.rowCount)return {error:'Every match participant must have a finalized result before corrections are allowed.',status:409};
    const priorByRegistration=new Map(prior.rows.map(row=>[row.registration_id,row]));
    const cashRisk=await client.query(`select c.id,c.status,exists(select 1 from payout_records pr where pr.cash_reward_id=c.id and pr.status in ('processing','paid')) payout_locked
      from cash_reward_records c join reward_transactions rt on rt.id=c.reward_transaction_id join match_results mr on mr.id=rt.result_id
      where mr.match_id=$1 and not exists(select 1 from match_results newer where newer.correction_of=mr.id)`,[req.params.id]);
    if(cashRisk.rows.some(row=>row.status==='paid'||row.payout_locked))return {error:'A cash reward from this result is already paid or processing. Reconcile that payout before correcting placements.',status:409};

    const correctionIds=[];
    for(const entry of data.placements){
      const previous=priorByRegistration.get(entry.registrationId);
      const saved=await client.query(`insert into match_results(match_id,registration_id,placement,finalized_by,finalized_at,correction_of)
        values($1,$2,$3,$4,now(),$5) returning id`,[req.params.id,entry.registrationId,entry.placement,userId(req),previous.id]);
      const resultId=saved.rows[0].id;

      const oldOg=await client.query('select id,user_id,team_id,points,reason from og_points_ledger where result_id=$1',[previous.id]);
      for(const ledger of oldOg.rows){
        if(Number(ledger.points)===0)continue;
        await client.query(`insert into og_points_ledger(user_id,team_id,result_id,points,reason,idempotency_key,created_by)
          values($1,$2,$3,$4,$5,$6,$7)`,[ledger.user_id,ledger.team_id,resultId,-Number(ledger.points),`Correction reversal: ${ledger.reason}`,`${resultId}:reverse:${ledger.id}`,userId(req)]);
      }
      const oldXp=await client.query('select id,user_id,points,reason from xp_points_ledger where idempotency_key like $1',[`${previous.id}:%`]);
      for(const ledger of oldXp.rows){
        if(Number(ledger.points)===0)continue;
        await client.query('insert into xp_points_ledger(user_id,points,reason,idempotency_key) values($1,$2,$3,$4)',[ledger.user_id,-Number(ledger.points),`Correction reversal: ${ledger.reason}`,`${resultId}:reverse:${ledger.id}`]);
      }
      const oldRewards=await client.query('select id from reward_transactions where result_id=$1 for update',[previous.id]);
      for(const transaction of oldRewards.rows){
        await client.query("update reward_transactions set status='reversed' where id=$1",[transaction.id]);
        const cash=await client.query("select id from cash_reward_records where reward_transaction_id=$1 and status<>'paid' for update",[transaction.id]);
        for(const record of cash.rows){
          await client.query("update payout_records set status='failed' where cash_reward_id=$1 and status='pending'",[record.id]);
          await client.query("update cash_reward_records set status='cancelled',updated_at=now() where id=$1",[record.id]);
        }
      }

      const rule=await client.query('select og_points,xp_points,cash_paise from reward_rules where tournament_id=$1 and placement in ($2,0) order by (placement=$2) desc limit 1',[match.rows[0].tournament_id,entry.placement]);
      const reward=rule.rows[0]||{og_points:0,xp_points:0,cash_paise:0};
      const registration=await client.query('select player_id,team_id from tournament_registrations where id=$1',[entry.registrationId]);
      const recipient=registration.rows[0];
      const transaction=await client.query("insert into reward_transactions(result_id,user_id,team_id,og_points,xp_points,cash_paise,status) values($1,$2,$3,$4,$5,$6,'confirmed') returning id",[resultId,recipient.player_id,recipient.team_id,reward.og_points,reward.xp_points,reward.cash_paise]);
      let members=[];
      if(recipient.team_id){
        const team=await client.query('select user_id from team_members where team_id=$1 order by joined_at',[recipient.team_id]);members=team.rows;
        await client.query('insert into og_points_ledger(team_id,result_id,points,reason,idempotency_key,created_by) values($1,$2,$3,$4,$5,$6)',[recipient.team_id,resultId,reward.og_points,`Corrected match placement ${entry.placement}`,`${resultId}:team`,userId(req)]);
      }else members=[{user_id:recipient.player_id}];
      for(const member of members){
        await client.query('insert into og_points_ledger(user_id,result_id,points,reason,idempotency_key,created_by) values($1,$2,$3,$4,$5,$6)',[member.user_id,resultId,reward.og_points,`Corrected match placement ${entry.placement}`,`${resultId}:${member.user_id}`,userId(req)]);
        if(Number(reward.xp_points)>0)await client.query('insert into xp_points_ledger(user_id,points,reason,idempotency_key) values($1,$2,$3,$4)',[member.user_id,reward.xp_points,`Corrected match placement ${entry.placement}`,`${resultId}:${member.user_id}`]);
        await client.query(`insert into notifications(user_id,kind,title,body,href) values($1,'match_result','Match result corrected',$2,'/rewards')`,[member.user_id,`Your recorded placement was updated to ${entry.placement}. Points and rewards have been adjusted.`]);
      }
      if(Number(reward.cash_paise)>0)await client.query("insert into cash_reward_records(reward_transaction_id,user_id,team_id,amount_paise,status) values($1,$2,$3,$4,'confirmed')",[transaction.rows[0].id,recipient.player_id,recipient.team_id,reward.cash_paise]);
      correctionIds.push({registrationId:entry.registrationId,previousResultId:previous.id,resultId});
    }
    await recordAudit(client,userId(req),'match_results_corrected','match',req.params.id,{reason:data.reason,corrections:correctionIds,placements:data.placements});
    await notifyAdmin(client,'match_correction','Match results corrected',data.reason,'/pass/ads/tournaments');
    return {correctionIds};
  });
  if(corrected.error)return res.status(corrected.status).json({error:corrected.error});
  res.json({corrected:true,...corrected});
});

platformRouter.get('/admin/upcoming', requireAdmin, async(req,res)=>{const result=await query('select * from upcoming_items order by display_order,created_at desc');res.json({data:result.rows});});
platformRouter.post('/admin/upcoming', requireAdmin, async(req,res)=>{
  const data=parse(z.object({title:z.string().trim().min(2).max(100),description:z.string().max(600).optional(),href:z.string().max(500).optional().or(z.literal('')).refine(safeHref),visible:z.boolean().optional(),pinned:z.boolean().optional(),displayOrder:z.number().int().optional(),startsAt:z.string().datetime().optional(),endsAt:z.string().datetime().optional()}),req.body);
  if(!data)return res.status(400).json({error:'Check upcoming item details.'});
  const result=await query('insert into upcoming_items(title,description,href,visible,pinned,display_order,starts_at,ends_at) values($1,$2,$3,$4,$5,$6,$7,$8) returning *',[data.title,data.description||'',data.href||null,data.visible??false,data.pinned??false,data.displayOrder||0,data.startsAt||null,data.endsAt||null]);
  await query('insert into admin_actions(admin_id,action,subject_type,subject_id) values($1,$2,$3,$4)',[userId(req),'upcoming_created','upcoming_item',result.rows[0].id]);res.status(201).json({item:result.rows[0]});
});
platformRouter.put('/admin/upcoming/:id', requireAdmin, async(req,res)=>{
  const data=parse(z.object({title:z.string().trim().min(2).max(100),description:z.string().max(600),href:z.string().max(500).optional().or(z.literal('')).refine(safeHref),visible:z.boolean(),pinned:z.boolean(),displayOrder:z.number().int(),startsAt:z.string().datetime().nullable().optional(),endsAt:z.string().datetime().nullable().optional()}),req.body);
  if(!data)return res.status(400).json({error:'Check upcoming item details.'});
  const result=await query('update upcoming_items set title=$2,description=$3,href=$4,visible=$5,pinned=$6,display_order=$7,starts_at=$8,ends_at=$9,updated_at=now() where id=$1 returning *',[req.params.id,data.title,data.description,data.href||null,data.visible,data.pinned,data.displayOrder,data.startsAt||null,data.endsAt||null]);
  if(!result.rowCount)return res.status(404).json({error:'Upcoming item not found.'});res.json({item:result.rows[0]});
});
platformRouter.delete('/admin/upcoming/:id', requireAdmin, async(req,res)=>{await query('delete from upcoming_items where id=$1',[req.params.id]);res.json({ok:true});});

platformRouter.get('/admin/assets',requireAdmin,async(req,res)=>{
  const result=await query(`select apa.id,apa.asset_type,apa.label,apa.min_level,apa.approved,ua.storage_path,ua.mime_type,ua.byte_size,ua.created_at,ua.approved storage_approved from approved_profile_assets apa join uploaded_assets ua on ua.id=apa.asset_id order by ua.created_at desc`);
  const assets=await Promise.all(result.rows.map(async asset=>({...asset,url:await signedAssetUrl(asset.storage_path)})));res.json({data:assets});
});
platformRouter.post('/admin/assets/upload',requireAdmin,uploadImage.single('asset'),async(req,res)=>{
  const type=['avatar','banner','background'].includes(req.body.assetType)?req.body.assetType:null;const label=String(req.body.label||'').trim().slice(0,80);const file=req.file;const detected=file&&imageType(file.buffer);
  const minLevel=Number(req.body.minLevel||1);
  if(!type||!label||!Number.isInteger(minLevel)||minLevel<1||minLevel>100||!file||!detected||file.mimetype!==detected.mime)return res.status(400).json({error:'Upload a PNG, JPEG, or WebP image with a label, asset type, and required level from 1 to 100.'});
  const path=`profile/${type}/${randomUUID()}.${detected.ext}`;
  try{
    await uploadProfileAsset(path,file.buffer,detected.mime);
    const asset=await withTransaction(async(client)=>{const uploaded=await client.query('insert into uploaded_assets(storage_path,mime_type,byte_size,uploaded_by,approved) values($1,$2,$3,$4,false) returning id',[path,detected.mime,file.size,userId(req)]);const profileAsset=await client.query('insert into approved_profile_assets(asset_id,asset_type,label,min_level,approved) values($1,$2,$3,$4,false) returning id,asset_type,label,min_level,approved',[uploaded.rows[0].id,type,label,minLevel]);await recordAudit(client,userId(req),'profile_asset_uploaded','profile_asset',profileAsset.rows[0].id,{assetType:type,minLevel,mimeType:detected.mime,byteSize:file.size});return profileAsset.rows[0];});res.status(201).json({asset:{...asset,storage_path:path}});
  }catch(error){try{await removeProfileAsset(path);}catch{}throw error;}
});
platformRouter.patch('/admin/assets/:id/approval',requireAdmin,async(req,res)=>{
  const data=parse(z.object({approved:z.boolean()}),req.body);if(!data)return res.status(400).json({error:'Set asset approval status.'});
  const result=await withTransaction(async(client)=>{const asset=await client.query('select asset_id from approved_profile_assets where id=$1 for update',[req.params.id]);if(!asset.rowCount)return null;await client.query('update uploaded_assets set approved=$2 where id=$1',[asset.rows[0].asset_id,data.approved]);await client.query('update approved_profile_assets set approved=$2 where id=$1',[req.params.id,data.approved]);await recordAudit(client,userId(req),data.approved?'profile_asset_approved':'profile_asset_unapproved','profile_asset',req.params.id);return {ok:true};});if(!result)return res.status(404).json({error:'Asset not found.'});res.json(result);
});
platformRouter.patch('/admin/assets/:id/level',requireAdmin,async(req,res)=>{
  const data=parse(z.object({minLevel:z.coerce.number().int().min(1).max(100)}),req.body);if(!data)return res.status(400).json({error:'Choose a required player level from 1 to 100.'});
  const result=await withTransaction(async(client)=>{const updated=await client.query('update approved_profile_assets set min_level=$2 where id=$1 returning id,min_level',[req.params.id,data.minLevel]);if(!updated.rowCount)return null;await recordAudit(client,userId(req),'profile_asset_level_changed','profile_asset',req.params.id,{minLevel:data.minLevel});return updated.rows[0];});
  if(!result)return res.status(404).json({error:'Profile artwork not found.'});res.json({asset:result});
});
platformRouter.delete('/admin/assets/:id',requireAdmin,async(req,res)=>{
  const result=await withTransaction(async(client)=>{const asset=await client.query(`select apa.id,apa.asset_id,ua.storage_path from approved_profile_assets apa join uploaded_assets ua on ua.id=apa.asset_id where apa.id=$1 for update`,[req.params.id]);if(!asset.rowCount)return null;const used=await client.query('select 1 from player_profiles where avatar_asset_id=$1 or background_asset_id=$1 or banner_asset_id=$1 limit 1',[req.params.id]);if(used.rowCount)return {error:'This asset is in use by a player profile. Unassign it before removal.'};await client.query('delete from approved_profile_assets where id=$1',[req.params.id]);await client.query('delete from uploaded_assets where id=$1',[asset.rows[0].asset_id]);await recordAudit(client,userId(req),'profile_asset_removed','profile_asset',req.params.id);return {path:asset.rows[0].storage_path};});if(!result)return res.status(404).json({error:'Asset not found.'});if(result.error)return res.status(409).json({error:result.error});await removeProfileAsset(result.path);res.json({ok:true});
});

platformRouter.get('/admin/analytics', requireAdmin, async(req,res)=>{
  const [games,players,results]=await Promise.all([
    query(`select g.name,count(r.id)::int registrations from games g left join tournaments t on t.game_id=g.id left join tournament_registrations r on r.tournament_id=t.id and r.status='confirmed' group by g.id order by registrations desc,g.name`),
    query(`select to_char(date_trunc('month',created_at),'YYYY-MM') as month_label,count(*)::int players from users where role='player' and created_at>=date_trunc('month',now())-interval '11 months' group by 1 order by 1`),
    query(`select t.status,count(*)::int count from tournaments t group by t.status order by t.status`),
  ]);
  res.json({registrationsByGame:games.rows,playerGrowth:players.rows,tournamentsByStatus:results.rows});
});
