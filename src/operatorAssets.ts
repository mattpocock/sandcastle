export const operatorPage =
  '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Sandcastle operator</title><link rel="stylesheet" href="/style.css"><body><main><h1>Sandcastle operator</h1><p id="project"></p><p>Settings saved during a run apply to the next run.</p><nav><a href="#workflow">Workflow</a> · <a href="#environment">Environment</a> · <a href="#prompts">Prompts</a> · <a href="#updates">Updates</a> · <a href="#migrations">Migration</a></nav><form id="roles"><div id="fields"></div><button type="submit">Save settings</button></form><section id="workflow"><h2>Workflow</h2><p>Repository routing is explicit. Settings apply to the next run. Commands and qualification policy remain project-owned.</p><form id="workflow-form"><div id="workflow-fields"></div><button type="submit">Save workflow</button></form><p id="workflow-diagnostics" role="status" aria-live="polite"></p></section><section id="environment"><h2>Environment</h2><p>Choose a host-installed image or enter a custom name. Save applies to the next run. Build and preflight use saved settings.</p><p id="image-availability" role="status"></p><form id="environment-form"><label>Docker image<select id="docker-image" aria-label="Docker image"></select></label><label id="custom-image-label">Custom Docker image<input id="custom-image" maxlength="255" aria-label="Custom Docker image"></label><label>Dockerfile<input id="dockerfile" required aria-label="Dockerfile"></label><label>Build arguments (KEY=value, one per line)<textarea id="build-args" rows="3" aria-label="Build arguments"></textarea></label><button type="submit">Save environment</button></form><button id="build-image" type="button">Build image</button> <button id="preflight" type="button">Run preflight</button> <button id="cancel-environment" type="button" disabled>Cancel environment job</button><p id="environment-job" role="status" aria-live="polite"></p><pre id="environment-logs" aria-label="Environment job logs" tabindex="0"></pre></section><section id="updates"><h2>Updates</h2><p>Package installation only. Workflows, prompts, gates and authentication remain project-owned. Restart the operator after installation.</p><form id="updates-form"><label>Runtime version or constraint<input id="update-version" aria-label="Runtime version or constraint" placeholder="Configured channel"></label><button type="submit">Preview runtime update</button></form><pre id="update-plan" tabindex="0" aria-label="Runtime update plan"></pre><button id="install-runtime" type="button" disabled>Install/update runtime</button> <button id="rollback-runtime" type="button">Roll back runtime</button><pre id="update-job" role="status" aria-live="polite"></pre></section><section id="migrations"><h2>Existing project migration</h2><p>Review generated workflow and configuration diffs. Migration preserves customization and does not establish readiness or acceptance.</p><button id="preview-migration" type="button">Preview project migration</button><pre id="migration-plan" tabindex="0" aria-label="Project migration plan"></pre><label><input id="migration-confirm" type="checkbox">I have reviewed the migration file diffs</label><label><input id="migration-preserve" type="checkbox">Preserve all project prompt overrides and conflicts</label><button id="apply-migration" type="button" disabled>Apply project migration</button> <button id="rollback-migration" type="button">Roll back migration</button><p id="migration-status" role="status" aria-live="polite"></p></section><section id="prompts"><h2>Prompts</h2><p>Compare with the current default. Overrides remain project-owned across default updates.</p><div id="prompt-fields"></div></section><p id="feedback" role="status" aria-live="polite"></p><button id="start" type="button">Start run</button><p id="run" role="status" aria-live="polite"></p><a href="/dashboard" target="_blank" rel="noopener">Observe runs and logs</a></main><script src="/app.js"></script></body></html>';
export const operatorStyles =
  "body{font:16px system-ui;background:#f6f8fa;color:#18212b;margin:0}main{max-width:850px;margin:2rem auto;padding:1rem}fieldset{display:flex;gap:1rem;flex-wrap:wrap;margin:1rem 0;padding:1rem;border:1px solid #bbc4cf}[hidden]{display:none!important}label{display:grid;gap:.4rem}input,select,button,textarea{font:inherit;padding:.5rem}button{cursor:pointer}legend{font-weight:600}a{color:#135bac}#feedback[data-error=true]{color:#a11}#workflow-fields,#environment-form{display:grid;gap:1rem;margin-bottom:1rem}#environment-logs{white-space:pre-wrap;overflow-wrap:anywhere;max-height:24rem;overflow:auto;background:#fff;padding:1rem}textarea:focus,input:focus,select:focus,button:focus,a:focus{outline:3px solid #2479d4;outline-offset:2px}";
export const operatorScript = `
let migrationPlan, migrationBusy=false;
function migrationButtons() {
 document.getElementById('apply-migration').disabled=migrationBusy || !migrationPlan || migrationPlan.status!=='ready' || !document.getElementById('migration-confirm').checked || (migrationPlan.conflicts.length>0 && !document.getElementById('migration-preserve').checked);
 document.getElementById('rollback-migration').disabled=migrationBusy;
 document.getElementById('preview-migration').disabled=migrationBusy;
}
for(const id of ['migration-confirm','migration-preserve']) document.getElementById(id).addEventListener('change',migrationButtons);
document.getElementById('preview-migration').addEventListener('click',async()=>{
 migrationPlan=null;migrationBusy=true;migrationButtons();
 document.getElementById('migration-confirm').checked=false;document.getElementById('migration-preserve').checked=false;
 try {
 migrationPlan=await request('/api/migrations/plan');
 document.getElementById('migration-status').textContent=migrationPlan.status+' · '+(migrationPlan.conflicts.length?'Prompt conflicts require explicit preservation.':'No prompt conflicts.');
 document.getElementById('migration-plan').textContent=migrationPlan.instructions+'\\n'+(migrationPlan.runtime?'Installed runtime: '+JSON.stringify(migrationPlan.runtime.installed)+'\\n':'')+migrationPlan.files.map(file=>file.path+'\\n'+diff(file.before || '',file.after || '')).join('\\n\\n')+'\\n'+migrationPlan.prompts.map(prompt=>prompt.role+' base → default\\n'+diff(prompt.base,prompt.default)+'\\nbase → project override\\n'+diff(prompt.base,prompt.override)).join('\\n\\n');
 }catch(error){document.getElementById('migration-status').textContent=error.message;}
 finally{migrationBusy=false;migrationButtons();}
});
for(const action of ['apply','rollback']) document.getElementById(action+'-migration').addEventListener('click',async()=>{
 if(action==='apply' && document.getElementById('apply-migration').disabled) return;
 migrationBusy=true;migrationButtons();document.getElementById('migration-status').textContent=action==='apply'?'Applying reviewed migration…':'Restoring migration…';
 try {
 const body=action==='apply'?{revision:migrationPlan.revision,preserveOverrides:document.getElementById('migration-preserve').checked}:{};
 const result=await request('/api/migrations/'+action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 document.getElementById('migration-status').textContent=result.status+' · Project migration. Readiness and acceptance remain project-owned.';
 await Promise.allSettled([load(),loadWorkflow(),loadEnvironment(),loadPrompts(null)]);
 }catch(error){document.getElementById('migration-status').textContent=error.message;}
 finally{migrationPlan=null;migrationBusy=false;migrationButtons();}
});
let updatePlan, updateBusy=false;
function renderUpdatePlan(plan) {
  updatePlan=plan;
  document.getElementById('update-plan').textContent =
    'Package: '+plan.config.package+' · registry: '+plan.config.registry+' · channel: '+plan.config.channel+' · manifest: '+plan.config.manifest+'\\n'+
    (plan.pinned ? 'Pinned local archive; does not follow npm latest.' : 'Explicit configured fork; no upstream fallback.')+'\\n'+
    'Installed: '+(plan.installed ? plan.installed.version+' · '+plan.installed.archive+' · '+plan.installed.integrity+' · '+(plan.installed.provenance ? plan.installed.provenance.source+'@'+plan.installed.provenance.commit : 'Legacy runtime; source provenance unavailable') : 'Not installed')+'\\n'+
    'Available: '+plan.target.version+' · '+plan.target.archive+' · '+plan.target.integrity+' · '+plan.target.provenance.source+'@'+plan.target.provenance.commit+'\\n'+
    'Action: '+plan.action+'\\nChangelog: '+plan.target.changelog;
  document.getElementById('install-runtime').disabled=updateBusy;
  document.getElementById('update-version').disabled=plan.pinned;
}
async function previewUpdate() {
  const version=document.getElementById('update-version').value.trim() || null;
  renderUpdatePlan(await request('/api/updates/plan',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({version})}));
}
document.getElementById('updates-form').addEventListener('submit',async event=>{
  event.preventDefault();try{await previewUpdate();}catch(error){updatePlan=null;document.getElementById('install-runtime').disabled=true;document.getElementById('update-plan').textContent=error.message;}
});
function renderUpdateJob(job) {
  if(!job) return;
  updateBusy=job.status==='running';
  document.getElementById('install-runtime').disabled=updateBusy || !updatePlan;
  document.getElementById('rollback-runtime').disabled=updateBusy;
  document.getElementById('update-job').textContent=job.status+'\\n'+job.logs.join('\\n')+(job.error?'\\n'+job.error:'');
  if(updateBusy) setTimeout(()=>request('/api/updates/job').then(data=>renderUpdateJob(data.job)).catch(error=>message(error.message,true)),250);
  else request('/api/updates').then(renderUpdatePlan).catch(error=>{document.getElementById('update-plan').textContent=error.message;});
}
document.getElementById('install-runtime').addEventListener('click',async()=>{
  if(!updatePlan) return;
  try {renderUpdateJob(await request('/api/updates/install',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({version:document.getElementById('update-version').value.trim() || null,revision:updatePlan.revision})}));}
  catch(error){document.getElementById('update-job').textContent=error.message;}
});
document.getElementById('rollback-runtime').addEventListener('click',async()=>{
  try {renderUpdateJob(await request('/api/updates/rollback',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}));}
  catch(error){document.getElementById('update-job').textContent=error.message;}
});
request('/api/updates').then(renderUpdatePlan).catch(error=>{document.getElementById('update-plan').textContent=error.message;});
request('/api/updates/job').then(data=>renderUpdateJob(data.job)).catch(error=>message(error.message,true));
let config;
const fields = document.getElementById('fields');
const feedback = document.getElementById('feedback');
const run = document.getElementById('run');
async function request(path, options) {
  const response = await fetch(path, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || 'Request failed');
  return body;
}
function message(text, error = false) {
  feedback.textContent = text;
  feedback.dataset.error = String(error);
}
let providers;
function option(select, value, text) {
  const item = document.createElement('option');
  item.value = value; item.textContent = text ?? value;
  select.append(item);
}
function labelled(text, control) {
  const label = document.createElement('label');
  label.textContent = text;
  label.append(control);
  return label;
}
function effortControl(id, provider, value, name) {
  const efforts = providers[provider].efforts;
  if (efforts === null) {
    const input = document.createElement('input');
    input.id = id; input.maxLength = 40; input.value = value ?? '';
    input.placeholder = 'provider default';
    input.setAttribute('aria-label', name + ' variant');
    return labelled(name + ' variant', input);
  }
  const select = document.createElement('select');
  select.id = id;
  select.setAttribute('aria-label', name + ' effort');
  if (efforts.length === 0) option(select, '', 'not applicable');
  for (const value of efforts) option(select, value);
  select.value = value ?? efforts[0] ?? '';
  select.disabled = efforts.length === 0;
  return labelled(name + ' effort', select);
}
function providerSelect(id, value, name) {
  const select = document.createElement('select');
  select.id = id;
  select.setAttribute('aria-label', name + ' provider');
  for (const provider of Object.keys(providers)) option(select, provider);
  select.value = value;
  return select;
}
function fallbackRow(role, list, target) {
  const index = list.children.length;
  const name = role[0].toUpperCase() + role.slice(1) + ' fallback ' + (index + 1);
  const row = document.createElement('div');
  row.className = 'fallback';
  const provider = providerSelect('', target.provider, name);
  provider.dataset.part = 'provider';
  const model = document.createElement('input');
  model.dataset.part = 'model'; model.maxLength = 200; model.required = true; model.value = target.model;
  model.setAttribute('aria-label', name + ' model');
  const effortSlot = document.createElement('span');
  function renderEffort() {
    effortSlot.replaceChildren(effortControl('', provider.value, target.effort, name));
    effortSlot.querySelector('select,input').dataset.part = 'effort';
  }
  provider.addEventListener('change', () => { target.effort = undefined; renderEffort(); });
  renderEffort();
  const remove = document.createElement('button');
  remove.type = 'button'; remove.textContent = 'Remove ' + name;
  remove.addEventListener('click', () => { row.remove(); list.dispatchEvent(new Event('change')); });
  row.append(labelled(name + ' provider', provider), labelled(name + ' model', model), effortSlot, remove);
  list.append(row);
}
async function load() {
  const data = await request('/api/config');
  fields.replaceChildren();
  config = data.config;
  providers = data.providers;
  document.getElementById('project').textContent = 'Project: ' + data.project;
  for (const [role, settings] of Object.entries(config.roles)) {
    const group = document.createElement('fieldset');
    const legend = document.createElement('legend');
    const title = role[0].toUpperCase() + role.slice(1);
    legend.textContent = title;
    group.append(legend);
    const provider = providerSelect(role + '-provider', settings.provider, title);
    const model = document.createElement('select');
    model.id = role + '-model';
    model.setAttribute('aria-label', title + ' model');
    const custom = document.createElement('input');
    custom.id = role + '-custom';
    custom.setAttribute('aria-label', title + ' custom model');
    custom.maxLength = 200;
    custom.value = settings.model;
    const customLabel = labelled(title + ' custom model', custom);
    const effortSlot = document.createElement('span');
    function renderProvider(effort) {
      const models = providers[provider.value].models;
      model.replaceChildren();
      for (const value of models) option(model, value);
      option(model, 'custom', 'Custom model ID');
      model.value = models.includes(custom.value) ? custom.value : 'custom';
      showCustom();
      effortSlot.replaceChildren(effortControl(role + '-effort', provider.value, effort, title));
    }
    function showCustom() {
      customLabel.hidden = model.value !== 'custom';
      custom.required = model.value === 'custom';
    }
    model.addEventListener('change', showCustom);
    provider.addEventListener('change', () => {
      custom.value = providers[provider.value].models[0] ?? '';
      renderProvider(undefined);
    });
    renderProvider(settings.effort);
    const list = document.createElement('div');
    list.id = role + '-fallback';
    for (const target of settings.fallback ?? []) fallbackRow(role, list, { ...target });
    const add = document.createElement('button');
    add.type = 'button'; add.textContent = 'Add ' + title + ' fallback';
    function canAdd() { add.disabled = list.children.length >= 3; }
    add.addEventListener('click', () => { fallbackRow(role, list, { provider: 'claudeCode', model: providers.claudeCode.models[0] ?? '' }); canAdd(); });
    list.addEventListener('change', canAdd);
    canAdd();
    group.append(labelled(title + ' provider', provider), labelled(title + ' model', model), customLabel, effortSlot, list, add);
    if (role === 'reviewer') {
      const preset = document.createElement('button');
      preset.type = 'button'; preset.textContent = 'Use cross-provider review preset';
      preset.addEventListener('click', () => {
        const implementer = document.getElementById('implementer-provider').value;
        const choice = implementer === 'claudeCode' ? { provider: 'codex', model: 'gpt-6.1-sol' } : { provider: 'claudeCode', model: 'claude-opus-5-5' };
        provider.value = choice.provider;
        custom.value = choice.model;
        renderProvider('high');
        message('Reviewer set to ' + choice.provider + ' / ' + choice.model + '. Save settings to apply.');
      });
      group.append(preset);
    }
    fields.append(group);
  }
}
function readEffort(control) {
  return control && !control.disabled && control.value ? control.value : undefined;
}
document.getElementById('roles').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.submitter;
  if (button) button.disabled = true;
  try {
    const roles = {};
    let upgrade = config.schemaVersion === 2;
    for (const role of Object.keys(config.roles)) {
      const selected = document.getElementById(role + '-model').value;
      const provider = document.getElementById(role + '-provider').value;
      const fallback = [...document.getElementById(role + '-fallback').children].map(row => {
        const target = { provider: row.querySelector('[data-part=provider]').value, model: row.querySelector('[data-part=model]').value };
        const effort = readEffort(row.querySelector('[data-part=effort]'));
        return effort === undefined ? target : { ...target, effort };
      });
      const effort = readEffort(document.getElementById(role + '-effort'));
      roles[role] = { provider, model: selected === 'custom' ? document.getElementById(role + '-custom').value : selected };
      if (effort !== undefined) roles[role].effort = effort;
      if (fallback.length) roles[role].fallback = fallback;
      if (provider !== 'codex' || fallback.length || effort === undefined) upgrade = true;
    }
    const next = { schemaVersion: upgrade ? 2 : 1, revision: config.revision, roles };
    const saved = await request('/api/config', { method: 'PUT', headers: {'Content-Type':'application/json'}, body: JSON.stringify(next) });
    config = saved.config;
    const notes = { created: ' Created CLAUDE.md importing AGENTS.md for Claude Code.', 'claude-md-unlinked': ' CLAUDE.md exists but does not import AGENTS.md; add @AGENTS.md so Claude Code sees the project instructions.' };
    message('Settings saved. Revision ' + config.revision.slice(0, 12) + '. Applies to the next run.' + (notes[saved.instructions] || ''));
    await load();
  } catch (error) { message(error.message, true); }
  finally { if (button) button.disabled = false; }
});
document.getElementById('start').addEventListener('click', async () => {
  try {
    await request('/api/run', { method:'POST', headers:{'Content-Type':'application/json'}, body:'{}' });
    await observe();
  } catch (error) { message(error.message, true); }
});
function diff(before, after) {
  if (before === after) return 'No changes.';
  const left = before.split('\\n'), right = after.split('\\n');
  let start = 0, end = 0;
  while (start < left.length && start < right.length && left[start] === right[start]) start++;
  while (end < left.length - start && end < right.length - start && left[left.length - end - 1] === right[right.length - end - 1]) end++;
  return left.slice(0, start).map(line => '  ' + line).concat(left.slice(start, left.length-end).map(line => '- ' + line), right.slice(start, right.length-end).map(line => '+ ' + line), left.slice(left.length-end).map(line => '  ' + line)).join('\\n');
}
async function loadPrompts(updatedRole) {
  const data = await request('/api/prompts');
  const container = document.getElementById('prompt-fields');
  if (updatedRole === null) container.replaceChildren();
  for (const [role, prompt] of Object.entries(data.prompts)) {
    if (updatedRole !== null && role !== updatedRole) continue;
    const form = document.createElement('form');
    form.id = role + '-prompt-form';
    const group = document.createElement('fieldset');
    group.style.display = 'block';
    const legend = document.createElement('legend');
    legend.textContent = role[0].toUpperCase() + role.slice(1);
    group.append(legend);
    if (!prompt) { const text = document.createElement('p'); text.textContent = 'No prompt configured by the project adapter.'; group.append(text); form.append(group); container.append(form); continue; }
    const status = document.createElement('p');
    status.textContent = (prompt.status === 'override' ? 'Override' : 'Default') + (prompt.defaultChanged ? ' · default changed' : '') + ' · default ' + prompt.default.version.slice(0,12) + ' · base ' + prompt.base.version.slice(0,12);
    const label = document.createElement('label');
    label.textContent = legend.textContent + ' prompt';
    const editor = document.createElement('textarea');
    editor.id = role + '-prompt'; editor.rows = 12; editor.style.width = '95%'; editor.value = prompt.content; editor.required = true;
    label.htmlFor = editor.id; label.append(editor);
    const changes = document.createElement('pre'); changes.style.whiteSpace = 'pre-wrap'; changes.setAttribute('aria-label', legend.textContent + ' prompt diff');
    const details = document.createElement('details'); const summary = document.createElement('summary'); summary.textContent = 'Diff against current default (− default, + editor)'; details.append(summary, changes);
    const update = () => changes.textContent = diff(prompt.default.content, editor.value);
    editor.addEventListener('input', update); update();
    const defaultDetails = document.createElement('details'); const defaultSummary = document.createElement('summary'); defaultSummary.textContent = 'Changed default diff (− original base, + current default)';
    const defaultDiff = document.createElement('pre'); defaultDiff.id = role + '-default-diff'; defaultDiff.style.whiteSpace = 'pre-wrap'; defaultDiff.textContent = diff(prompt.base.content, prompt.default.content); defaultDetails.append(defaultSummary, defaultDiff);
    const save = document.createElement('button'); save.type = 'submit'; save.textContent = 'Save ' + role + ' prompt';
    const reset = document.createElement('button'); reset.type = 'button'; reset.textContent = 'Reset ' + role + ' prompt';
    async function persist(content) {
      const restoreFocus = form.contains(document.activeElement);
      save.disabled = reset.disabled = true;
      editor.disabled = true;
      try { await request('/api/prompts', {method:'PUT', headers:{'Content-Type':'application/json'}, body:JSON.stringify({role, content})}); await loadPrompts(role); message(role + ' prompt ' + (content === null ? 'reset' : 'saved') + '. Applies to the next run.'); }
      catch (error) { message(error.message, true); }
      finally {
        save.disabled = reset.disabled = editor.disabled = false;
        if (restoreFocus && document.activeElement === document.body) document.getElementById(form.id).querySelector(content === null ? 'button[type=button]' : 'button[type=submit]').focus();
      }
    }
    form.addEventListener('submit', event => { event.preventDefault(); persist(editor.value); }); reset.addEventListener('click', () => persist(null));
    group.append(status, label, details, defaultDetails, save, reset); form.append(group);
    const previous = document.getElementById(form.id);
    if (previous) previous.replaceWith(form); else container.append(form);
  }
}
async function observe() {
  try {
    const data = await request('/api/run');
    if (!data.run) { run.textContent = 'No run started in this operator session.'; return; }
    document.getElementById('start').disabled = data.run.status === 'running';
    run.textContent = 'Run ' + data.run.id + ' · ' + data.run.status + ' · revision ' + data.run.config.revision.slice(0,12) + ' · runtime ' + data.run.runtimeVersion + '\\n' +
      Object.entries(data.run.config.roles).map(([role, settings]) => role + ': ' + settings.model + ' / ' + settings.effort).join(' · ') +
      (data.run.workflow ? '\\nRepository: ' + (data.run.workflow.repository || 'not configured') + ' · concurrency ' + data.run.workflow.limits.concurrency + ' · cycles ' + data.run.workflow.limits.cycles + ' · workflow revision ' + data.run.workflow.revision.slice(0,12) : '') +
      (data.run.diagnostics || []).map(diagnostic => '\\n' + ({'qualification-pending':'External qualification pending: ' + diagnostic.issues.join(', '),'no-progress':'No verified implementation progress. Inspect runs and logs before resuming.','iteration-limit':'Workflow iteration limit reached. Inspect the remaining backlog.','provider-unavailable':'Agent provider unavailable after consecutive provider failures. Check provider status, authentication and fallbacks, then resume.','feedback-failed':'Project feedback gate or verifier failed. Inspect project declarations and runs/logs.'}[diagnostic.code] || '')).join('');
  } catch (error) { run.textContent = 'Cannot observe run: ' + error.message; }
}
let workflowConfig;
const workflowFields = document.getElementById('workflow-fields');
function workflowDiagnostic(data) {
  document.getElementById('workflow-diagnostics').textContent = data.diagnostics.join(' ') +
    ' Project-required holds: ' + (data.requiredHoldLabels.join(', ') || 'none') +
    ' · required gates: ' + (data.requiredGates.join(', ') || 'none');
}
async function loadWorkflow() {
  const data = await request('/api/workflow'); workflowConfig = data.config;
  workflowFields.replaceChildren();
  function input(key, title, value, type = 'text', min, max) {
    const label = document.createElement('label'); label.textContent = title;
    const field = document.createElement(key === 'holdLabels' ? 'textarea' : 'input');
    field.id = 'workflow-' + key; field.setAttribute('aria-label', title);
    field.value = value; if (key !== 'holdLabels') field.type = type;
    field.required = key !== 'repository' && key !== 'holdLabels';
    if (min !== undefined) { field.min = min; field.max = max; field.step = 1; }
    label.append(field); workflowFields.append(label);
  }
  input('repository', 'Repository (owner/repository)', workflowConfig.repository || '');
  for(const [key, title] of [['scopeLabel','Scope label'],['readyLabel','Ready label'],['blockedLabel','Blocked label']]) input(key,title,workflowConfig[key]);
  input('holdLabels','Hold labels (one per line)',workflowConfig.holdLabels.join('\\n'));
  for(const [key,title,min,max] of [['cycles','Workflow cycles',1,1000],['concurrency','Issue concurrency',1,100],['plannerAttempts','Planner attempts',1,10]]) input(key,title,workflowConfig.limits[key],'number',min,max);
  function select(key,title,values,current) {
    const label=document.createElement('label'); label.textContent=title;
    const field=document.createElement('select');field.id='workflow-'+key;field.setAttribute('aria-label',title);
    for(const value of values) {const option=document.createElement('option');option.value=value;option.textContent=value || 'Not configured';field.append(option);}
    field.value=current || '';label.append(field);workflowFields.append(label);
  }
  select('mode','Readiness mode',['report-only','apply'],workflowConfig.readiness.mode);
  select('verifier','Trusted verifier',['',...data.references.verifiers],workflowConfig.readiness.verifier);
  const gates=document.createElement('fieldset'); const legend=document.createElement('legend');legend.textContent='Project feedback gates';gates.append(legend);
  for(const id of data.references.gates) {
    const label=document.createElement('label');label.textContent=id;
    const field=document.createElement('input');field.type='checkbox';field.dataset.gate=id;field.setAttribute('aria-label','Feedback gate '+id);field.checked=workflowConfig.readiness.gates.includes(id);label.append(field);gates.append(label);
  }
  const reviewLabel=document.createElement('label');reviewLabel.textContent='Require a different reviewer provider';
  const reviewField=document.createElement('input');reviewField.type='checkbox';reviewField.id='workflow-requireDifferentProvider';reviewField.setAttribute('aria-label','Require a different reviewer provider');reviewField.checked=Boolean(workflowConfig.review && workflowConfig.review.requireDifferentProvider);reviewLabel.append(reviewField);
  const roundsLabel=document.createElement('label');roundsLabel.textContent='Review repair rounds';
  const roundsField=document.createElement('input');roundsField.type='number';roundsField.min='0';roundsField.max='5';roundsField.id='workflow-maxRepairRounds';roundsField.setAttribute('aria-label','Review repair rounds');roundsField.value=String(workflowConfig.review && workflowConfig.review.maxRepairRounds !== undefined ? workflowConfig.review.maxRepairRounds : 2);roundsLabel.append(roundsField);
  const mergeLabel=document.createElement('label');mergeLabel.textContent='Merge mode';
  const mergeField=document.createElement('select');mergeField.id='workflow-mergeMode';mergeField.setAttribute('aria-label','Merge mode');
  for(const [value,text] of [['batch','Batch: one merger after every pipeline settles'],['per-branch','Per-branch: merge each approved branch at once']]){const option=document.createElement('option');option.value=value;option.textContent=text;mergeField.append(option);}
  mergeField.value=(workflowConfig.merge && workflowConfig.merge.mode) || 'batch';mergeLabel.append(mergeField);
  workflowFields.append(gates,reviewLabel,roundsLabel,mergeLabel);workflowDiagnostic(data);
}
document.getElementById('workflow-form').addEventListener('submit',async event=>{
  event.preventDefault();event.submitter.disabled=true;
  try {
    const next=structuredClone(workflowConfig);
    const value=key=>document.getElementById('workflow-'+key).value;
    next.repository=value('repository') || null;
    for(const key of ['scopeLabel','readyLabel','blockedLabel']) next[key]=value(key);
    next.holdLabels=value('holdLabels').split('\\n').map(label=>label.trim()).filter(Boolean);
    for(const key of ['cycles','concurrency','plannerAttempts']) next.limits[key]=Number(value(key));
    next.readiness={mode:value('mode'),verifier:value('verifier') || null,gates:[...workflowFields.querySelectorAll('input[data-gate]:checked')].map(field=>field.dataset.gate)};
    const requireDifferent=document.getElementById('workflow-requireDifferentProvider').checked;
    const repairRounds=Number(document.getElementById('workflow-maxRepairRounds').value);
    const review={...(next.review||{})};
    if(requireDifferent || review.requireDifferentProvider !== undefined) review.requireDifferentProvider=requireDifferent;
    if(repairRounds !== 2 || review.maxRepairRounds !== undefined) review.maxRepairRounds=repairRounds;
    if(Object.keys(review).length) next.review=review;
    const mergeMode=document.getElementById('workflow-mergeMode').value;
    if(mergeMode !== 'batch' || next.merge) next.merge={mode:mergeMode};
    workflowConfig=(await request('/api/workflow',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(next)})).config;
    workflowDiagnostic(await request('/api/workflow'));message('Workflow saved. Revision '+workflowConfig.revision.slice(0,12)+'. Applies to the next run.');
  } catch(error) {message(error.message,true);} finally {event.submitter.disabled=false;}
});
loadWorkflow().catch(error=>message(error.message,true));
let environmentConfig, environmentJob, environmentEvents;
const imageSelect = document.getElementById('docker-image');
const customImage = document.getElementById('custom-image');
function showCustomImage() {
  document.getElementById('custom-image-label').hidden = imageSelect.value !== 'custom';
  customImage.required = imageSelect.value === 'custom';
}
imageSelect.addEventListener('change', showCustomImage);
function availability(data) {
  document.getElementById('image-availability').textContent = 'Configured image: ' + data.config.image + ' · ' + (data.available ? 'Available on host · ' + data.identity : 'Unavailable on host; check Docker or build the image.');
}
async function loadEnvironment() {
  const data = await request('/api/environment'); environmentConfig = data.config;
  imageSelect.replaceChildren();
  for(const value of [...data.images, 'custom']) {
    const option = document.createElement('option'); option.value=value; option.textContent=value === 'custom' ? 'Custom image name' : value; imageSelect.append(option);
  }
  imageSelect.value = data.images.includes(data.config.image) ? data.config.image : 'custom';
  customImage.value = data.config.image; showCustomImage();
  document.getElementById('dockerfile').value = data.config.dockerfile;
  document.getElementById('build-args').value = Object.entries(data.config.buildArgs).map(([key,value]) => key+'='+value).join('\\n');
  availability(data);
}
document.getElementById('environment-form').addEventListener('submit', async event => {
  event.preventDefault(); event.submitter.disabled=true;
  try {
    const buildArgs = {};
    for(const line of document.getElementById('build-args').value.split('\\n').filter(line => line.trim())) {
      const equals = line.indexOf('='); if(equals < 1) throw new Error('Build arguments require KEY=value, one per line.');
      const key=line.slice(0,equals); if(Object.hasOwn(buildArgs,key)) throw new Error('Duplicate build argument: '+key);
      Object.defineProperty(buildArgs,key,{value:line.slice(equals+1),enumerable:true});
    }
    environmentConfig = (await request('/api/environment',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({schemaVersion:1,image:imageSelect.value === 'custom' ? customImage.value : imageSelect.value,dockerfile:document.getElementById('dockerfile').value,buildArgs})})).config;
    availability(await request('/api/environment')); message('Environment saved. Applies to the next run.');
  } catch(error) {message(error.message,true);}
  finally {event.submitter.disabled=false;}
});
function showEnvironmentJob(job) {
  environmentJob = job;
  const active = ['running','cancelling','promoting'].includes(job.status);
  document.getElementById('build-image').disabled = document.getElementById('preflight').disabled = active;
  document.getElementById('cancel-environment').disabled = job.status !== 'running';
  document.getElementById('environment-job').textContent = job.kind+' · '+job.status+' · '+job.config.image+(job.identity ? ' · '+job.identity : '')+(job.error ? ' · '+job.error : '');
  document.getElementById('environment-logs').textContent = job.logs;
  if(!active) {
    environmentEvents?.close();
    request('/api/environment').then(availability).catch(error=>message(error.message,true));
  }
}
function watchEnvironmentJob(job) {
  showEnvironmentJob(job); environmentEvents?.close();
  if(!['running','cancelling','promoting'].includes(job.status)) return;
  environmentEvents = new EventSource('/api/environment/jobs/'+job.id+'/events');
  environmentEvents.onmessage = event => showEnvironmentJob(JSON.parse(event.data));
  environmentEvents.onerror = () => { request('/api/environment/jobs/'+job.id).then(showEnvironmentJob).catch(error=>message(error.message,true)); };
}
async function startEnvironmentJob(kind) {
  try {
    const job = await request('/api/environment/jobs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({kind})});
    watchEnvironmentJob(job);
  } catch(error) {message(error.message,true);}
}
document.getElementById('build-image').addEventListener('click',()=>startEnvironmentJob('build'));
document.getElementById('preflight').addEventListener('click',()=>startEnvironmentJob('preflight'));
document.getElementById('cancel-environment').addEventListener('click',async()=> {
  try {showEnvironmentJob(await request('/api/environment/jobs/'+environmentJob.id+'/cancel',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}));} catch(error) {message(error.message,true);}
});
loadEnvironment().catch(error => message(error.message,true));
request('/api/environment/jobs').then(data => {const job=data.jobs.at(-1);if(job) watchEnvironmentJob(job);}).catch(error=>message(error.message,true));
loadPrompts(null).catch(error => message(error.message, true));
load().catch(error => message(error.message, true));
observe();
setInterval(observe, 1000);
`;
