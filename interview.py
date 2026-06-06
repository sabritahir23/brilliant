tasks = [
    {
        "task_id": "t1",
        "member_id": "m1",
        "status": "open",
        "priority": "high",
        "owner": "nurse",
        "due_date": "2026-05-10"
    },
    {
        "task_id": "t2",
        "member_id": "m1",
        "status": "completed",
        "priority": "medium",
        "owner": "care_coordinator",
        "due_date": "2026-05-08"
    },
    {
        "task_id": "t3",
        "member_id": "m2",
        "status": "open",
        "priority": "low",
        "owner": "nurse",
        "due_date": "2026-05-12"
    },
    {
        "task_id": "t4",
        "member_id": "m1",
        "status": "open",
        "priority": "high",
        "owner": "social_worker",
        "due_date": "2026-05-07"
    },
    {
        "task_id": "t5",
        "member_id": "m2",
        "status": "completed",
        "priority": "high",
        "owner": "nurse",
        "due_date": "2026-05-09"
    }
]
def summarize_tasks(tasks):
    T = {}

    for task in tasks:
        task_id   = task['task_id']
        member_id = task['member_id']
        status    = task['status']
        priority  = task['priority']
        owner     = task['owner']
        due_date  = task['due_date']

        if member_id not in T:
            T[member_id] = {
                'total_tasks'                 : 1, 
                'open_tasks'                  : 1    if status   == 'open'      else 0,
                'completed_tasks'             : 1    if status   == 'completed' else 0,
                'has_high_priority_open_task' : True if priority == 'high'      and status == 'open' else False,
                'owners'                      : [owner],
                'next_due_open_task_id'       : task_id if status == 'open' else None,
                'last_due_date'               : due_date if status == 'open' else None
            }
        else:
            T[member_id]['total_tasks'] += 1
            if status == 'open':
                T[member_id]['open_tasks'] += 1
            if status == 'completed':
                T[member_id]['completed_tasks'] += 1
            if priority == 'high' and T[member_id]['has_high_priority_open_task'] == False and status == 'open':
                T[member_id]['has_high_priority_open_task'] = True
            if owner not in T[member_id]['owners']:
                T[member_id]['owners'].append(owner)
            if (due_date < T[member_id]['last_due_date'] or T[member_id]['last_due_date'] == None) and status == 'open':
                T[member_id]['last_due_date'] = due_date
                T[member_id]['next_due_open_task_id'] = task_id

    
    for x in T:
        del T[x]['last_due_date']

    return T

print(summarize_tasks(tasks))
