async profile => {
 const info=await profile(true);if(!info||info.error)return info;
 if(!Array.isArray(info.buckets)||info.buckets.length!==1)return {owner:info.owner,path:null};
 const bucket=info.buckets[0],story=bucket?.first_story_to_show;
 if(!/^\d+$/.test(bucket?.id||'')||typeof story?.id!=='string'||!story.id||story.id.length>512)return {owner:info.owner,path:null};
 return {owner:info.owner,path:'/stories/'+bucket.id+'/'+encodeURIComponent(story.id)+'/'};
}
