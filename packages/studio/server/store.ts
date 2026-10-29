import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { capability, initialContent, validateContent, type Artifact, type ArtifactKind, type Role, type User } from '../shared/domain.ts';

export class HttpError extends Error {
  constructor(public statusCode: number, message: string) { super(message); }
}
export const hash = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');
const now = () => new Date().toISOString();
const artifactCols = 'id, project_id AS projectId, kind, title, content, version, updated_at AS updatedAt, created_at AS createdAt, created_by AS createdBy, archived';
export class Store {
  db: DatabaseSync;
  constructor(file: string) {
    if(file !== ':memory:') mkdirSync(dirname(file), {recursive:true,mode:0o700});
    this.db = new DatabaseSync(file);
    const schemaVersion=(this.db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version;
    if(schemaVersion>1){this.db.close();throw new Error('This database was created by a newer Studio version; refusing an unsafe downgrade');}
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,email TEXT UNIQUE NOT NULL,name TEXT NOT NULL,password TEXT,color TEXT NOT NULL,oidc_sub TEXT UNIQUE);
      CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,expires INTEGER NOT NULL,kind TEXT NOT NULL DEFAULT 'session');
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,title TEXT NOT NULL,description TEXT NOT NULL,repository TEXT NOT NULL DEFAULT '',main_artifact_id TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memberships(project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,role TEXT NOT NULL CHECK(role IN ('owner','editor','viewer')),PRIMARY KEY(project_id,user_id));
      CREATE TABLE IF NOT EXISTS artifacts(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,kind TEXT NOT NULL,title TEXT NOT NULL,content TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1,ystate BLOB,updated_at TEXT NOT NULL,created_at TEXT NOT NULL,created_by TEXT NOT NULL REFERENCES users(id),archived INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS decisions(id TEXT PRIMARY KEY,artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,title TEXT NOT NULL,context TEXT NOT NULL,decision TEXT NOT NULL,consequences TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'proposed',version INTEGER NOT NULL DEFAULT 1,author TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS threads(id TEXT PRIMARY KEY,artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,anchor TEXT,quote TEXT NOT NULL DEFAULT '',resolved INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,thread_id TEXT NOT NULL REFERENCES threads(id),author_id TEXT NOT NULL REFERENCES users(id),author TEXT NOT NULL,role TEXT NOT NULL,body TEXT NOT NULL,proposal TEXT,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS revisions(id INTEGER PRIMARY KEY,artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,version INTEGER NOT NULL,content TEXT NOT NULL,actor TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(artifact_id,version));
      CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,artifact_id TEXT REFERENCES artifacts(id) ON DELETE CASCADE,actor TEXT NOT NULL,action TEXT NOT NULL,detail TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,artifact_version INTEGER NOT NULL,status TEXT NOT NULL,result TEXT,error TEXT,created_at TEXT NOT NULL,finished_at TEXT);
      CREATE TABLE IF NOT EXISTS files(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,name TEXT NOT NULL,mime TEXT NOT NULL,sha256 TEXT NOT NULL,bytes BLOB NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS links(id TEXT PRIMARY KEY,artifact_id TEXT NOT NULL REFERENCES artifacts(id) ON DELETE CASCADE,label TEXT NOT NULL,url TEXT NOT NULL,kind TEXT NOT NULL,state TEXT NOT NULL DEFAULT 'unknown',updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS artifacts_project ON artifacts(project_id,archived);
      CREATE INDEX IF NOT EXISTS messages_thread ON messages(thread_id,created_at);
      CREATE INDEX IF NOT EXISTS runs_artifact ON runs(artifact_id,created_at);
      CREATE INDEX IF NOT EXISTS audit_project ON audit(project_id,id);
      PRAGMA user_version=1;
    `);
    this.db.prepare("UPDATE runs SET status='interrupted', error='Server restarted during execution', finished_at=? WHERE status IN ('queued','running')").run(now());
  }
  one(sql:string,...args:any[]): any { return this.db.prepare(sql).get(...args); }
  all(sql:string,...args:any[]): any[] { return this.db.prepare(sql).all(...args); }
  exec(sql:string,...args:any[]) { return this.db.prepare(sql).run(...args); }
  tx<T>(fn:()=>T):T { this.db.exec('BEGIN IMMEDIATE'); try { const result=fn(); this.db.exec('COMMIT'); return result; } catch(e) {this.db.exec('ROLLBACK');throw e;} }
  close() { this.db.close(); }
  publicUser(id:string):User { const u=this.one('SELECT id,email,name,color FROM users WHERE id=?',id); if(!u)throw new HttpError(401,'Sign in to continue');return u; }
  userByEmail(email:string) {return this.one('SELECT * FROM users WHERE email=?',email.toLowerCase());}
  createUser(email:string,name:string,password:string|null,sub:string|null=null):User {
    const id=randomUUID(); const color=['#6b73d1','#378469','#b06440','#8a5eb0'][parseInt(id[0]!,16)%4]!;
    this.exec('INSERT INTO users(id,email,name,password,color,oidc_sub) VALUES(?,?,?,?,?,?)',id,email.toLowerCase(),name,password,color,sub);
    return this.publicUser(id);
  }
  role(projectId:string,userId:string,action:'read'|'write'|'admin'='read'):Role {
    const r=this.one('SELECT role FROM memberships WHERE project_id=? AND user_id=?',projectId,userId)?.role as Role|undefined;
    if(!r)throw new HttpError(404,'Project not found');
    if(!capability(r,action))throw new HttpError(403,'Your project role does not allow this action');
    return r;
  }
  artifact(id:string,userId:string,action:'read'|'write'|'admin'='read'):Artifact {
    const a=this.one(`SELECT ${artifactCols} FROM artifacts WHERE id=?`,id);
    if(!a)throw new HttpError(404,'Artifact not found');
    this.role(a.projectId,userId,action);
    if(a.archived&&action!=='read')throw new HttpError(409,'This artifact is archived');
    return {...a,content:JSON.parse(a.content),archived:!!a.archived};
  }
  artifacts(projectId:string,userId:string) {
    this.role(projectId,userId);
    return this.all(`SELECT ${artifactCols} FROM artifacts WHERE project_id=? AND archived=0 ORDER BY created_at,id`,projectId).map(a=>({...a,content:JSON.parse(a.content),archived:!!a.archived}));
  }
  projects(userId:string) {return this.all('SELECT p.id,p.title,p.description,p.repository,p.main_artifact_id AS mainArtifactId,p.updated_at AS updatedAt,m.role FROM projects p JOIN memberships m ON m.project_id=p.id WHERE m.user_id=? ORDER BY p.updated_at DESC',userId);}
  audit(projectId:string,artifactId:string|null,actor:string,action:string,detail='') {
    this.exec('INSERT INTO audit(project_id,artifact_id,actor,action,detail,created_at) VALUES(?,?,?,?,?,?)',projectId,artifactId,actor,action,detail,now());
  }
  createProject(user:User,title:string,description:string,repository='') {
    return this.tx(()=>{
      const id=randomUUID(), mainId=randomUUID();
      this.exec('INSERT INTO projects VALUES(?,?,?,?,?,?)',id,title,description,repository,mainId,now());
      this.exec('INSERT INTO memberships VALUES(?,?,?)',id,user.id,'owner');
      this.insertArtifact(user,id,'design',title+' — design',mainId);
      this.audit(id,null,user.name,'project.created',title);
      return this.projects(user.id).find(p=>p.id===id);
    });
  }
  insertArtifact(user:User,projectId:string,kind:ArtifactKind,title:string,id=randomUUID(),content=initialContent(kind,title)):Artifact {
    const c=JSON.stringify(validateContent(kind,content)); const t=now();
    this.exec('INSERT INTO artifacts(id,project_id,kind,title,content,updated_at,created_at,created_by) VALUES(?,?,?,?,?,?,?,?)',id,projectId,kind,title,c,t,t,user.id);
    this.exec('INSERT INTO revisions(artifact_id,version,content,actor,created_at) VALUES(?,?,?,?,?)',id,1,c,user.name,t);
    this.exec('INSERT INTO decisions(id,artifact_id,title,context,decision,consequences,author,updated_at) VALUES(?,?,?,?,?,?,?,?)',randomUUID(),id,'ADR · '+title,'Why does this artifact exist?','Record the chosen approach and its owner.','Record tradeoffs and alternatives.',user.name,t);
    this.exec('INSERT INTO threads(id,artifact_id,created_at) VALUES(?,?,?)',randomUUID(),id,t);
    this.audit(projectId,id,user.name,'artifact.created',kind);
    return this.artifact(id,user.id);
  }
  createArtifact(user:User,projectId:string,kind:ArtifactKind,title:string,content?:Record<string,any>) {
    this.role(projectId,user.id,'write');return this.tx(()=>this.insertArtifact(user,projectId,kind,title,undefined,content));
  }
  updateArtifact(user:User,id:string,version:number,content:unknown,title?:string):Artifact {
    const a=this.artifact(id,user.id,'write');
    const c=JSON.stringify(validateContent(a.kind,content));
    return this.tx(()=>{
      const t=now();
      const r=this.exec('UPDATE artifacts SET content=?,title=?,version=version+1,updated_at=? WHERE id=? AND version=?',c,title??a.title,t,id,version);
      if(r.changes!==1)throw new HttpError(409,'This artifact changed. Reload the latest version before saving.');
      this.exec('INSERT INTO revisions(artifact_id,version,content,actor,created_at) VALUES(?,?,?,?,?)',id,version+1,c,user.name,t);
      this.exec('UPDATE projects SET updated_at=? WHERE id=?',t,a.projectId);
      this.audit(a.projectId,id,user.name,'artifact.updated',`version ${version+1}`);
      return this.artifact(id,user.id);
    });
  }
  state(id:string):Uint8Array|null {return this.one('SELECT ystate FROM artifacts WHERE id=?',id)?.ystate??null;}
  persistDoc(user:User,id:string,state:Uint8Array,content:Record<string,any>) {
    const a=this.artifact(id,user.id,'write');
    return this.tx(()=>{
      this.exec('UPDATE artifacts SET ystate=? WHERE id=?',state,id);
      if(JSON.stringify(a.content)!==JSON.stringify(content))this.updateDocContent(user,a,content);
    });
  }
  private updateDocContent(user:User,a:Artifact,content:Record<string,any>) {
    const c=JSON.stringify(validateContent(a.kind,content)),t=now();
    this.exec('UPDATE artifacts SET content=?,version=version+1,updated_at=? WHERE id=?',c,t,a.id);
    this.exec('INSERT INTO revisions(artifact_id,version,content,actor,created_at) VALUES(?,?,?,?,?)',a.id,a.version+1,c,user.name,t);
    this.exec('UPDATE projects SET updated_at=? WHERE id=?',t,a.projectId);
    this.audit(a.projectId,a.id,user.name,'document.edited',`version ${a.version+1}`);
  }
  threads(id:string) {return this.all('SELECT id,artifact_id AS artifactId,anchor,quote,resolved,created_at AS createdAt FROM threads WHERE artifact_id=? ORDER BY created_at,id',id).map(t=>({...t,resolved:!!t.resolved}));}
  messages(id:string) {return this.all('SELECT id,artifact_id AS artifactId,thread_id AS threadId,author,author_id AS authorId,role,body,proposal,created_at AS createdAt FROM (SELECT rowid AS sequence,* FROM messages WHERE artifact_id=? ORDER BY rowid DESC LIMIT 1000) ORDER BY sequence',id).map(m=>({...m,proposal:m.proposal?JSON.parse(m.proposal):null}));}
  message(user:User,id:string,threadId:string,body:string,role='user',proposal:unknown=null) {
    this.artifact(id,user.id,'write');
    if(!this.one('SELECT id FROM threads WHERE id=? AND artifact_id=?',threadId,id))throw new HttpError(404,'Discussion not found');
    const mid=randomUUID();this.exec('INSERT INTO messages VALUES(?,?,?,?,?,?,?,?,?)',mid,id,threadId,user.id,role==='assistant'?'Studio agent':user.name,role,body,proposal?JSON.stringify(proposal):null,now());
    const m=this.one('SELECT id,artifact_id AS artifactId,thread_id AS threadId,author,author_id AS authorId,role,body,proposal,created_at AS createdAt FROM messages WHERE id=?',mid);return {...m,proposal:m.proposal?JSON.parse(m.proposal):null};
  }
  decisions(id:string) {return this.all('SELECT id,artifact_id AS artifactId,title,context,decision,consequences,status,version,author,updated_at AS updatedAt FROM decisions WHERE artifact_id=? ORDER BY updated_at,id',id);}
  runs(id:string) {return this.all('SELECT id,artifact_id AS artifactId,artifact_version AS artifactVersion,status,result,error,created_at AS createdAt,finished_at AS finishedAt FROM runs WHERE artifact_id=? ORDER BY created_at DESC LIMIT 100',id).map(r=>({...r,result:r.result?JSON.parse(r.result):null}));}
}
