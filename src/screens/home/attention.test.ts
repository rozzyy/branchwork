import { attentionItems } from "./attention";

it("orders inbox events newest first and pins conflicts", () => {
  expect(attentionItems([
    {id:"old",kind:"review",title:"Old",meta:"",at:1},
    {id:"new",kind:"agent",title:"New",meta:"",at:3},
    {id:"mid",kind:"ci",title:"Mid",meta:"",at:2},
  ], [{worktree:"/wt/a",count:2}]).map((item) => item.id)).toEqual(["conflict:/wt/a","new","mid","old"]);
});

it("preserves filter kinds from Inbox", () => {
  expect(attentionItems([
    {id:"mention",kind:"mention",title:"Mention",meta:"",at:2},
    {id:"agent",kind:"agent",title:"Agent",meta:"",at:1},
  ], []).map(({kind}) => kind)).toEqual(["mention","agent"]);
});
