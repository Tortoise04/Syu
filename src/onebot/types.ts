export interface MessageSegment {
  type: string;
  data: { text?: string; [key: string]: unknown };
}

export interface Sender {
  user_id: number;
  nickname: string;
  card?: string;
  role?: string;
}

/** 群里/私聊里真正推上来的一条消息 */
export interface MessageEvent {
  post_type: 'message';
  message_type: 'group' | 'private';
  sub_type?: string;
  time: number;
  self_id: number;
  message_id: number;
  user_id: number;
  group_id?: number;
  message: string | MessageSegment[];
  raw_message?: string;
  sender: Sender;
}

/** 自己发出去的消息回显；和 message 长得很像，但走的是另一条 post_type */
export interface MessageSentEvent {
  post_type: 'message_sent';
  message_type: 'group' | 'private';
  time: number;
  self_id: number;
  message_id: number;
  user_id: number;
  group_id?: number;
  message: string | MessageSegment[];
  raw_message?: string;
  sender: Sender;
}

export interface NoticeEvent {
  post_type: 'notice';
  notice_type: string;
  time: number;
  self_id: number;
  [key: string]: unknown;
}

export interface RequestEvent {
  post_type: 'request';
  request_type: string;
  time: number;
  self_id: number;
  [key: string]: unknown;
}

export interface MetaEvent {
  post_type: 'meta_event';
  meta_event_type: string;
  time: number;
  self_id: number;
}

/** 用字面量成员而不是宽 post_type，这样 post_type !== 'message' 能把类型收窄 */
export type OneBotEvent = MessageEvent | MessageSentEvent | NoticeEvent | RequestEvent | MetaEvent;

export interface LoginInfo {
  user_id: number;
  nickname: string;
}

export interface GroupInfo {
  group_id: number;
  group_name: string;
}

export interface SendResult {
  message_id?: number;
}

export interface ApiResponse<T> {
  status?: string;
  retcode?: number;
  data?: T;
  echo?: string;
}
