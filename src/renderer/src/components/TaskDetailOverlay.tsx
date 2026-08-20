import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '@/store/store';
import { TaskDetail, parseTasks, type HiveTask } from './TasksKanban';

/**
 * App-wide host for the task detail: whoever calls store.openTaskDetail(id) —
 * a kanban card, the sticky note on an agent's strip card, a floor prop —
 * gets the SAME big overlay rendered over the office floor. Keeps its own
 * 5s ledger poll so an open detail stays fresh while the god edits cards.
 */

const POLL_MS = 5000;

export function TaskDetailOverlay() {
  const taskDetailId = useStore((s) => s.taskDetailId);
  const closeTaskDetail = useStore((s) => s.closeTaskDetail);
  const agents = useStore((s) => s.agents);
  const restorable = useStore((s) => s.restorableAgents);
  const [tasks, setTasks] = useState<HiveTask[]>([]);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    // parseTasks NORMALIZES (the ledger is a hand-written file; cards may lack
    // dependsOn/priority/etc.) — a raw card without dependsOn crashed the
    // detail once. Never feed TaskDetail unparsed ledger entries.
    try { setTasks(parseTasks(await window.cth.hiveTasks())); } catch { /* keep last good */ }
  }, []);

  useEffect(() => {
    if (!taskDetailId) return;
    void refresh();
    timer.current = setInterval(() => { void refresh(); }, POLL_MS);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [taskDetailId, refresh]);

  if (!taskDetailId) return null;
  const task = tasks.find((t) => t.id === taskDetailId);
  if (!task) return null;

  const nameFor = (id?: string): string | undefined =>
    id ? (agents.find((a) => a.id === id)?.name ?? restorable.find((a) => a.id === id)?.name ?? id) : undefined;

  // Moving a card writes ONE field, and now says exactly that: main patches the
  // named card on its own latest on-disk ledger.
  //
  // This used to read the RAW ledger here and write the whole array back, to keep
  // parseTasks' normalization off the disk — re-serializing the display model
  // turns a hand-written `priority: "high"` into the number 3 and grafts
  // `dependsOn: []` onto a card that spells the key `deps`. Sending only the
  // changed field keeps that guarantee (nothing is re-serialized) and closes the
  // gap the old shape could not: between the read and the write, a webhook or the
  // god could add a card, and the array we sent was the membership, so the new
  // card vanished.
  const move = async (status: HiveTask['status']) => {
    setTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, status } : t))); // optimistic
    try {
      const result = await window.cth.hivePatchTask(task.id, { status });
      if (!result.ok) void refresh();
    } catch { void refresh(); }
  };

  const assign = () => {
    // Route through the Command Center's dispatch box (which mails the god —
    // the human never writes into a worker's inbox directly).
    const st = useStore.getState();
    const god = st.agents.find((a) => a.isGod);
    if (god) st.select(god.id);
    const desc = task.description?.trim() ? task.description.trim() : '(no description)';
    st.requestDispatchSeed(`Task: ${task.title}\nContext: ${desc}\n`);
    st.requestCommandCenterTab('floor');
    closeTaskDetail();
  };

  return (
    <TaskDetail
      task={task}
      all={tasks}
      assigneeName={nameFor(task.assignee)}
      onMove={(s) => void move(s)}
      onAssign={assign}
      onClose={closeTaskDetail}
    />
  );
}
