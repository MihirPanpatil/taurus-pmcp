// Drives the fixture's UI the way a person would during record mode: every feature once, through the page itself.
// The shell runs this inside the page; it only clicks and types, it never calls the API directly.
(async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const $ = (selector) => document.querySelector(selector);
  const until = async (check, ms = 5000) => {
    const start = Date.now();
    while (Date.now() - start < ms) {
      const value = check();
      if (value) return value;
      await sleep(50);
    }
    throw new Error('exercise: timed out waiting for the page');
  };
  const type = (element, value) => {
    element.value = value;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const row = (text) => [...document.querySelectorAll('#task-list li')].find((li) => li.textContent.includes(text));

  await until(() => $('#project-select')?.options.length);

  type($('#new-project-name'), 'Exercise project');
  $('#new-project-btn').click();
  await until(() => [...$('#project-select').options].some((o) => o.text === 'Exercise project'));
  await sleep(200);

  type($('#task-title'), 'Exercise task');
  type($('#task-desc'), 'Walk through every feature once');
  type($('#task-due'), '2030-01-15');
  $('#add-task-btn').click();
  await until(() => row('Exercise task'));

  row('Exercise task').querySelector('.title').click();
  await until(() => $('#details').textContent.includes('Exercise task'));

  row('Exercise task').querySelector('.toggle').click();
  await until(() => row('Exercise task')?.classList.contains('done'));
  row('Exercise task').querySelector('.toggle').click();
  await until(() => !row('Exercise task')?.classList.contains('done'));

  const editing = row('Exercise task');
  editing.querySelector('.edit').click();
  type(editing.querySelector('.edit-input'), 'Exercise task renamed');
  editing.querySelector('.save').click();
  await until(() => row('Exercise task renamed'));

  type($('#search'), 'renamed');
  await sleep(300);
  type($('#search'), '');
  await sleep(300);

  type($('#filter'), 'done');
  await sleep(300);
  type($('#filter'), 'open');
  await sleep(300);
  type($('#filter'), 'all');
  await sleep(300);

  row('Exercise task renamed').querySelector('.delete').click();
  await until(() => !row('Exercise task renamed'));
  return 'exercise complete';
})();
