// Every write that puts a post into design review (approvalStatus "pending") also records who sent it,
// when, and how many times: the designer dashboard shows how long a design has waited and which round it is.
// A post created already in review is round 1; a draft sent with Submit adds one.

export const firstSubmission = (userId: string) => ({ submittedAt: new Date(), submittedById: userId, submitCount: 1 });

export const nextSubmission = (userId: string) => ({ submittedAt: new Date(), submittedById: userId, submitCount: { increment: 1 } });
