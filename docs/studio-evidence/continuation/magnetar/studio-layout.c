#include "../rt/om.h"
int main(void) {
 if(om_input_len()!=16) return 1;
 uint64_t w=om_read_u64(0),o=om_read_u64(8);
 if(w<20480 || w>262144 || o>1) return 2;
 uint64_t s=w>=57600?14848:0;
 uint64_t d=(w>=81920 && o)?21760:0;
 om_write_u64(s);om_write_u64(d);om_write_u64(w-s-d);return 0;
}
